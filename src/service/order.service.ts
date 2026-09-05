import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import {
  OrderStatus,
  PaymentStatus,
  StockMovementType,
  ReservationStatus,
  Prisma,
} from '@prisma/client';
import { createPixPayment } from './payment.service';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface CreateOrderItemInput {
  productId: number;
  quantity: number;
}

interface CreateOrderInput {
  userId: number;
  items: CreateOrderItemInput[];
  expirationMinutes?: number; // padrão 30
}

// ==============================================
// FUNÇÃO PRINCIPAL DE CRIAÇÃO DE PEDIDO
// ==============================================

/**
 * Cria um pedido de forma atômica:
 * - Verifica e bloqueia o estoque, decrementando dentro da mesma transação.
 * - Cria o pedido, itens (com snapshot de preço) e reservas.
 * - Após a transação, cria o pagamento Pix no Mercado Pago.
 * - Se a criação do pagamento falhar, executa compensação: cancela reservas e pedido.
 *
 * Garantias:
 * - Não vende a mesma unidade para duas pessoas (updateMany condicional).
 * - Se qualquer item não tiver estoque suficiente, toda a operação é desfeita.
 * - Não deixa estoque reservado sem pedido/pagamento (compensação em caso de falha).
 */
export async function createOrder(
  input: CreateOrderInput
): Promise<{ order: Prisma.OrderGetPayload<{}>; payment: Prisma.PaymentGetPayload<{}> }> {
  const { userId, items, expirationMinutes = 30 } = input;

  if (items.length === 0) {
    throw new Error('Pedido deve conter ao menos um item');
  }

  // Busca os produtos uma única vez para validação inicial e snapshot de preço.
  const productIds = items.map((item) => item.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, active: true },
  });

  if (products.length !== productIds.length) {
    throw new Error('Um ou mais produtos não existem ou estão inativos');
  }

  const productMap = new Map(products.map((p) => [p.id, p]));

  // 1) TRANSAÇÃO ATÔMICA: pedido + itens + reserva de estoque + movimentos
  let order: Prisma.OrderGetPayload<{}>;

  try {
    order = await prisma.$transaction(async (tx) => {
      // Cria o pedido (status PENDING)
      const newOrder = await tx.order.create({
        data: {
          userId,
          status: OrderStatus.PENDING,
          total: 0, // será calculado
          expiresAt: new Date(Date.now() + expirationMinutes * 60 * 1000),
        },
      });

      let total = 0;

      // Para cada item: snapshot de preço, criação do item e reserva de estoque
      for (const item of items) {
        const product = productMap.get(item.productId)!;

        // Atualiza o estoque de forma condicional (garante atomicidade)
        const updateResult = await tx.product.updateMany({
          where: {
            id: item.productId,
            stock: { gte: item.quantity },
          },
          data: {
            stock: { decrement: item.quantity },
          },
        });

        // Se nenhuma linha foi atualizada, estoque insuficiente
        if (updateResult.count === 0) {
          throw new Error(`Estoque insuficiente para o produto ${product.name}`);
        }

        // Cria o OrderItem com o preço atual (snapshot)
        const orderItem = await tx.orderItem.create({
          data: {
            orderId: newOrder.id,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: product.price,
            name: product.name,
          },
        });

        total += product.price.toNumber() * item.quantity;

        // Cria a Reservation (estoque já decrementado)
        const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);
        const reservation = await tx.reservation.create({
          data: {
            userId,
            productId: item.productId,
            orderId: newOrder.id,
            quantity: item.quantity,
            status: ReservationStatus.ACTIVE,
            expiresAt,
          },
        });

        // Registra o movimento de estoque (saída por reserva)
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: StockMovementType.OUT,
            quantity: -item.quantity,
            referenceId: reservation.id,
            referenceType: 'reservation',
          },
        });
      }

      // Atualiza o total do pedido
      await tx.order.update({
        where: { id: newOrder.id },
        data: { total },
      });

      logger.info(
        { orderId: newOrder.id, userId, total, itemsCount: items.length },
        'Pedido criado e estoque reservado atomicamente.'
      );

      return tx.order.findUnique({
        where: { id: newOrder.id },
        include: { items: true },
      }) as Promise<Prisma.OrderGetPayload<{}>>;
    });
  } catch (error) {
    // A transação inteira foi revertida automaticamente.
    logger.error({ error, userId }, 'Falha ao criar pedido (transação revertida)');
    throw new Error('Não foi possível criar o pedido. Estoque insuficiente ou erro interno.');
  }

  // 2) FORA DA TRANSAÇÃO: criar pagamento Pix
  let payment: Prisma.PaymentGetPayload<{}>;
  try {
    payment = await createPixPayment({
      orderId: order.id,
      userId,
      amount: order.total.toNumber(),
      description: `Pedido #${order.id}`,
      expirationMinutes,
    });
  } catch (error) {
    // Se falhar a criação do pagamento, precisamos desfazer as reservas e cancelar o pedido
    logger.error({ error, orderId: order.id }, 'Falha ao criar pagamento, compensando...');
    await compensateFailedPayment(order.id);
    throw new Error('Falha ao gerar pagamento. Pedido cancelado e estoque devolvido.');
  }

  logger.info({ orderId: order.id, paymentId: payment.id }, 'Pedido criado com sucesso.');
  return { order, payment };
}

/**
 * Compensação: desfaz reservas e cancela pedido caso a criação do pagamento falhe.
 * Essa função deve ser idempotente, pois pode ser chamada mais de uma vez.
 */
async function compensateFailedPayment(orderId: number): Promise<void> {
  try {
    // Busca reservas ativas do pedido
    const activeReservations = await prisma.reservation.findMany({
      where: { orderId, status: ReservationStatus.ACTIVE },
    });

    // Para cada reserva, devolve o estoque e marca como CANCELED
    for (const reservation of activeReservations) {
      await prisma.$transaction(async (tx) => {
        // Devolve o estoque
        await tx.product.update({
          where: { id: reservation.productId },
          data: { stock: { increment: reservation.quantity } },
        });

        // Atualiza a reserva para CANCELED
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: ReservationStatus.CANCELED, updatedAt: new Date() },
        });

        // Registra movimento de cancelamento
        await tx.stockMovement.create({
          data: {
            productId: reservation.productId,
            type: StockMovementType.IN,
            quantity: reservation.quantity,
            referenceId: reservation.id,
            referenceType: 'cancel_reservation',
          },
        });
      });
    }

    // Cancela o pedido
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELED, canceledAt: new Date() },
    });

    logger.info({ orderId }, 'Compensação concluída: pedido cancelado e estoque devolvido.');
  } catch (compError) {
    // Se a compensação falhar, registra erro grave para intervenção manual/automática
    logger.error({ compError, orderId }, 'FALHA NA COMPENSAÇÃO - Necessária intervenção');
  }
}

/**
 * Cancela um pedido pendente (manualmente ou por expiração).
 * - Cancela o pagamento no Mercado Pago (se existir).
 * - Devolve o estoque das reservas ativas.
 * - Atualiza status do pedido.
 * Idempotente.
 */
export async function cancelOrder(orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  });

  if (!order) {
    throw new Error('Pedido não encontrado');
  }

  if (order.status !== OrderStatus.PENDING) {
    logger.warn({ orderId, status: order.status }, 'Tentativa de cancelar pedido não pendente');
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Cancela pagamentos pendentes (se houver)
      for (const payment of order.payments) {
        if (payment.status === PaymentStatus.PENDING && payment.externalId) {
          // Futuramente: chamar API do Mercado Pago para cancelar o pagamento
          // Por enquanto, atualiza localmente
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.CANCELED },
          });
        }
      }

      // Devolve estoque das reservas ativas
      const activeReservations = await tx.reservation.findMany({
        where: { orderId, status: ReservationStatus.ACTIVE },
      });

      for (const reservation of activeReservations) {
        await tx.product.update({
          where: { id: reservation.productId },
          data: { stock: { increment: reservation.quantity } },
        });

        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: ReservationStatus.CANCELED, updatedAt: new Date() },
        });

        await tx.stockMovement.create({
          data: {
            productId: reservation.productId,
            type: StockMovementType.IN,
            quantity: reservation.quantity,
            referenceId: reservation.id,
            referenceType: 'cancel_reservation',
          },
        });
      }

      // Cancela o pedido
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELED, canceledAt: new Date() },
      });
    });

    logger.info({ orderId }, 'Pedido cancelado com sucesso.');
  } catch (error) {
    logger.error({ error, orderId }, 'Erro ao cancelar pedido');
    throw error;
  }
}

/**
 * Obtém pedido por ID com itens e pagamentos.
 */
export async function getOrderById(orderId: number): Promise<Prisma.OrderGetPayload<{
  include: { items: true; payments: true };
}> | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true },
  });
}

/**
 * Processa pedido após confirmação de pagamento (webhook aprovado).
 * Consome as reservas ativas (transforma em consumo definitivo) e
 * poderá disparar comissões de afiliados no futuro.
 * Idempotente: se o pedido já estiver PAID, não faz nada.
 */
export async function handleOrderPaid(orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { reservations: true },
  });

  if (!order) {
    throw new Error('Pedido não encontrado');
  }

  if (order.status !== OrderStatus.PENDING) {
    logger.warn({ orderId, status: order.status }, 'Pedido já processado ou cancelado');
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Atualiza status do pedido
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.PAID, paidAt: new Date() },
      });

      // Consome as reservas ativas
      for (const reservation of order.reservations) {
        if (reservation.status === ReservationStatus.ACTIVE) {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: ReservationStatus.CONSUMED, updatedAt: new Date() },
          });

          // Movimento de estoque de consumo definitivo (opcional, já houve saída na reserva)
          // Pode-se criar outro movimento se desejar rastrear consumo separado.
          await tx.stockMovement.create({
            data: {
              productId: reservation.productId,
              type: StockMovementType.OUT,
              quantity: -reservation.quantity,
              referenceId: reservation.id,
              referenceType: 'consumption',
            },
          });
        }
      }

      // TODO: Chamar serviço de comissões de afiliados com tx (quando implementado)
    });

    logger.info({ orderId }, 'Pedido marcado como pago e reservas consumidas.');
  } catch (error) {
    logger.error({ error, orderId }, 'Erro ao processar pedido pago');
    throw error;
  }
}
