import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import {
  StockMovementType,
  ReservationStatus,
  Prisma,
} from '@prisma/client';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface ReserveStockInput {
  userId: number;
  productId: number;
  quantity: number;
  orderId?: number; // opcional, se vinculado a um pedido
  expirationMinutes?: number; // padrão 30 minutos
}

// ==============================================
// FUNÇÕES PÚBLICAS
// ==============================================

/**
 * Verifica o estoque disponível real de um produto.
 * Retorna o estoque atual (não considera reservas ativas? Depende da regra).
 * Para ser realista, deve considerar o estoque físico menos as reservas ativas.
 * Porém, como o estoque é decrementado no momento da reserva, o estoque atual já reflete as reservas.
 * Aqui retornaremos o estoque do produto.
 */
export async function getAvailableStock(productId: number): Promise<number> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stock: true },
  });
  if (!product) {
    throw new Error('Produto não encontrado');
  }
  return product.stock;
}

/**
 * Reserva estoque para um usuário/pedido.
 * Decrementa o estoque do produto de forma atômica e cria um registro de Reservation.
 * Retorna a Reservation criada.
 * Idempotente: se já existir uma Reservation ativa para a mesma orderId e productId, retorna a existente.
 */
export async function reserveStock(
  input: ReserveStockInput
): Promise<Prisma.ReservationGetPayload<{}>> {
  const { userId, productId, quantity, orderId, expirationMinutes = 30 } = input;

  if (quantity <= 0) {
    throw new Error('Quantidade deve ser maior que zero');
  }

  // Se houver orderId, verifica se já existe reserva ativa para evitar duplicidade
  if (orderId) {
    const existingReservation = await prisma.reservation.findFirst({
      where: {
        orderId,
        productId,
        status: ReservationStatus.ACTIVE,
      },
    });
    if (existingReservation) {
      logger.info(
        { orderId, productId, reservationId: existingReservation.id },
        'Reserva ativa já existe para este pedido; reutilizando.'
      );
      return existingReservation;
    }
  }

  const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);

  try {
    // Transação para garantir atomicidade
    return await prisma.$transaction(async (tx) => {
      // Decrementa estoque se suficiente
      const updateResult = await tx.product.updateMany({
        where: {
          id: productId,
          stock: { gte: quantity },
        },
        data: {
          stock: { decrement: quantity },
        },
      });

      if (updateResult.count === 0) {
        throw new Error('Estoque insuficiente para reservar');
      }

      // Cria a Reservation
      const reservation = await tx.reservation.create({
        data: {
          userId,
          productId,
          orderId,
          quantity,
          status: ReservationStatus.ACTIVE,
          expiresAt,
        },
      });

      // Registra movimento de estoque
      await tx.stockMovement.create({
        data: {
          productId,
          type: StockMovementType.OUT, // saída temporária via reserva
          quantity: -quantity,
          referenceId: reservation.id,
          referenceType: 'reservation',
        },
      });

      logger.info(
        { reservationId: reservation.id, productId, quantity, orderId },
        'Estoque reservado com sucesso.'
      );
      return reservation;
    });
  } catch (error) {
    logger.error({ error, productId, quantity }, 'Erro ao reservar estoque');
    throw error;
  }
}

/**
 * Consome a reserva (quando o pagamento é aprovado).
 * Marca a reserva como CONSUMED e registra movimento de estoque de saída definitiva.
 */
export async function consumeReservation(
  reservationId: number
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new Error('Reserva não encontrada');
      }
      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new Error('Reserva não está ativa');
      }

      // Atualiza status para CONSUMED
      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: ReservationStatus.CONSUMED,
          updatedAt: new Date(),
        },
      });

      // Registra movimento de estoque de saída definitiva (consumo)
      await tx.stockMovement.create({
        data: {
          productId: reservation.productId,
          type: StockMovementType.OUT,
          quantity: -reservation.quantity,
          referenceId: reservation.id,
          referenceType: 'consumption',
        },
      });

      logger.info({ reservationId }, 'Reserva consumida.');
    });
  } catch (error) {
    logger.error({ error, reservationId }, 'Erro ao consumir reserva');
    throw error;
  }
}

/**
 * Cancela a reserva (quando o pagamento expira, é cancelado ou falha).
 * Devolve o estoque ao produto e marca a reserva como CANCELED.
 */
export async function cancelReservation(
  reservationId: number
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new Error('Reserva não encontrada');
      }
      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new Error('Reserva não está ativa');
      }

      // Devolve o estoque
      await tx.product.update({
        where: { id: reservation.productId },
        data: {
          stock: { increment: reservation.quantity },
        },
      });

      // Marca como CANCELED
      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: ReservationStatus.CANCELED,
          updatedAt: new Date(),
        },
      });

      // Registra movimento de estoque de cancelamento (entrada)
      await tx.stockMovement.create({
        data: {
          productId: reservation.productId,
          type: StockMovementType.IN,
          quantity: reservation.quantity,
          referenceId: reservation.id,
          referenceType: 'cancel_reservation',
        },
      });

      logger.info({ reservationId }, 'Reserva cancelada e estoque devolvido.');
    });
  } catch (error) {
    logger.error({ error, reservationId }, 'Erro ao cancelar reserva');
    throw error;
  }
}

/**
 * Expira reservas antigas (chamado periodicamente ou via worker).
 * Localiza reservas ACTIVE com expiresAt < now e as cancela.
 */
export async function expireOldReservations(): Promise<number> {
  const now = new Date();
  const activeReservations = await prisma.reservation.findMany({
    where: {
      status: ReservationStatus.ACTIVE,
      expiresAt: { lt: now },
    },
    select: { id: true },
  });

  for (const reservation of activeReservations) {
    try {
      await cancelReservation(reservation.id);
    } catch (error) {
      logger.error({ error, reservationId: reservation.id }, 'Falha ao expirar reserva');
    }
  }

  return activeReservations.length;
}

/**
 * Adiciona estoque ao produto (entrada manual ou reposição).
 * Registra o movimento.
 */
export async function addStock(
  productId: number,
  quantity: number,
  referenceType?: string,
  referenceId?: number
): Promise<void> {
  if (quantity <= 0) {
    throw new Error('Quantidade deve ser positiva');
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { stock: { increment: quantity } },
      });

      await tx.stockMovement.create({
        data: {
          productId,
          type: StockMovementType.IN,
          quantity,
          referenceId,
          referenceType,
        },
      });
    });
    logger.info({ productId, quantity }, 'Estoque adicionado.');
  } catch (error) {
    logger.error({ error, productId, quantity }, 'Erro ao adicionar estoque');
    throw error;
  }
}

/**
 * Remove estoque do produto manualmente (ajuste).
 * Registra o movimento.
 */
export async function removeStock(
  productId: number,
  quantity: number,
  referenceType?: string,
  referenceId?: number
): Promise<void> {
  if (quantity <= 0) {
    throw new Error('Quantidade deve ser positiva');
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updateResult = await tx.product.updateMany({
        where: { id: productId, stock: { gte: quantity } },
        data: { stock: { decrement: quantity } },
      });
      if (updateResult.count === 0) {
        throw new Error('Estoque insuficiente');
      }

      await tx.stockMovement.create({
        data: {
          productId,
          type: StockMovementType.OUT,
          quantity: -quantity,
          referenceId,
          referenceType,
        },
      });
    });
    logger.info({ productId, quantity }, 'Estoque removido.');
  } catch (error) {
    logger.error({ error, productId, quantity }, 'Erro ao remover estoque');
    throw error;
  }
}
