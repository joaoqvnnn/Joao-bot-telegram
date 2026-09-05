import mercadopago from 'mercadopago';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { env } from '../config/env';
import { PaymentStatus, OrderStatus, Prisma } from '@prisma/client';

// ==============================================
// CONFIGURAÇÃO DO MERCADO PAGO
// ==============================================

let configured = false;

function configureMercadoPago() {
  if (configured) return;
  mercadopago.configure({
    access_token: env.mercadoPago.accessToken,
  });
  configured = true;
  logger.info('Mercado Pago configurado.');
}

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface CreatePixPaymentInput {
  orderId: number;
  userId: number;
  amount: number;
  description: string;
  expirationMinutes?: number; // padrão: 30 minutos
}

// ==============================================
// FUNÇÕES PÚBLICAS
// ==============================================

/**
 * Cria um pagamento Pix no Mercado Pago e registra no banco.
 * Idempotente: se já existir um Payment pendente para a mesma order,
 * retorna o existente em vez de criar outro.
 */
export async function createPixPayment(
  input: CreatePixPaymentInput
): Promise<Prisma.PaymentGetPayload<{}>> {
  configureMercadoPago();

  const { orderId, userId, amount, description, expirationMinutes = 30 } = input;

  // Verifica se já existe pagamento pendente para esta ordem
  const existingPayment = await prisma.payment.findFirst({
    where: {
      orderId,
      status: PaymentStatus.PENDING,
    },
  });

  if (existingPayment && existingPayment.externalId) {
    logger.info(
      { orderId, paymentId: existingPayment.id, externalId: existingPayment.externalId },
      'Pagamento pendente já existe; reutilizando.'
    );
    return existingPayment;
  }

  // Gera dados do pagamento Pix
  const expirationDate = new Date(Date.now() + expirationMinutes * 60 * 1000);
  const paymentData = {
    transaction_amount: Number(amount.toFixed(2)),
    description,
    payment_method_id: 'pix',
    payer: {
      // O Mercado Pago exige email, mas para Pix podemos usar um placeholder
      // Nota: este campo é obrigatório na API, mas o webhook trará o email real se fornecido.
      email: 'cliente@exemplo.com',
    },
    date_of_expiration: expirationDate.toISOString(),
    notification_url: env.mercadoPago.webhookUrl,
  };

  try {
    const response = await mercadopago.payment.create(paymentData);

    const mpPayment = response.body;
    const externalId = String(mpPayment.id);
    const qrCode = mpPayment.point_of_interaction?.transaction_data?.qr_code || null;
    const qrCodeBase64 = mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 || null;

    // Cria o registro no banco com status PENDING
    const payment = await prisma.payment.create({
      data: {
        orderId,
        userId,
        method: 'PIX',
        status: PaymentStatus.PENDING,
        amount,
        externalId,
        qrCode,
        qrCodeBase64,
        expirationDate,
        webhookData: mpPayment,
      },
    });

    logger.info(
      { orderId, paymentId: payment.id, externalId },
      'Pagamento Pix criado no Mercado Pago.'
    );
    return payment;
  } catch (error) {
    logger.error({ error, orderId }, 'Erro ao criar pagamento Pix no Mercado Pago');
    throw new Error('Falha ao criar pagamento Pix. Tente novamente.');
  }
}

/**
 * Consulta o status atual de um pagamento no Mercado Pago.
 */
export async function checkPaymentStatus(externalId: string): Promise<any> {
  configureMercadoPago();
  try {
    const response = await mercadopago.payment.get(externalId);
    return response.body;
  } catch (error) {
    logger.error({ error, externalId }, 'Erro ao consultar status do pagamento');
    throw new Error('Falha ao consultar pagamento no Mercado Pago.');
  }
}

/**
 * Processa o webhook do Mercado Pago.
 * Idempotente: verifica se o evento já foi processado (tabela WebhookEvent),
 * consulta o status no Mercado Pago e atualiza o Payment e Order.
 */
export async function processPaymentWebhook(
  eventId: string,
  payload: any
): Promise<void> {
  configureMercadoPago();

  // Verifica se o evento já foi processado (idempotência)
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: { eventId },
  });

  if (existingEvent && existingEvent.status === 'PROCESSED') {
    logger.info({ eventId }, 'Evento já processado anteriormente; ignorando.');
    return;
  }

  if (existingEvent && existingEvent.status === 'PROCESSING') {
    logger.warn({ eventId }, 'Evento em processamento por outra instância; ignorando.');
    return;
  }

  // Marca como PROCESSING para evitar processamento duplicado simultâneo
  await prisma.webhookEvent.upsert({
    where: { eventId },
    update: { status: 'PROCESSING' },
    create: {
      provider: 'mercadopago',
      eventId,
      type: payload?.type || 'unknown',
      payload,
      status: 'PROCESSING',
    },
  });

  try {
    // O payload pode conter o ID do pagamento diretamente ou em data.id
    const paymentId = payload?.data?.id || payload?.id;
    if (!paymentId) {
      throw new Error('Webhook não contém ID do pagamento');
    }

    const mpPayment = await checkPaymentStatus(String(paymentId));

    // Mapeia status do Mercado Pago para nossos enums
    const mappedStatus = mapMercadoPagoStatusToPaymentStatus(mpPayment.status);

    // Busca o Payment no banco pelo externalId
    const payment = await prisma.payment.findUnique({
      where: { externalId: String(paymentId) },
      include: { order: true },
    });

    if (!payment) {
      logger.warn({ paymentId }, 'Pagamento não encontrado no banco para o webhook recebido');
      // Mesmo assim, marca o evento como processado (não havia nada para atualizar)
      await prisma.webhookEvent.update({
        where: { eventId },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      return;
    }

    // Se o status mudou, atualiza payment e order
    if (payment.status !== mappedStatus) {
      await prisma.$transaction(async (tx) => {
        // Atualiza o Payment
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: mappedStatus,
            approvedAt: mappedStatus === PaymentStatus.APPROVED ? new Date() : null,
            webhookData: mpPayment,
          },
        });

        // Se aprovado, atualiza a Order para PAID
        if (mappedStatus === PaymentStatus.APPROVED) {
          await tx.order.update({
            where: { id: payment.orderId },
            data: {
              status: OrderStatus.PAID,
              paidAt: new Date(),
            },
          });

          // Dispara ações de pós-pagamento (estoque, comissões, etc.)
          // Essas funções serão implementadas nos serviços correspondentes.
          // Por enquanto, registra no log.
          logger.info(
            { orderId: payment.orderId, paymentId: payment.id },
            'Pagamento aprovado. Processando pós-pagamento...'
          );
          // Chamadas futuras: await handleOrderPaid(payment.orderId, tx);
        }

        // Se rejeitado/expirado/cancelado, atualiza a Order para CANCELED ou EXPIRED
        if ([PaymentStatus.REJECTED, PaymentStatus.CANCELED].includes(mappedStatus)) {
          await tx.order.update({
            where: { id: payment.orderId },
            data: {
              status: OrderStatus.CANCELED,
              canceledAt: new Date(),
            },
          });
        } else if (mappedStatus === PaymentStatus.EXPIRED) {
          await tx.order.update({
            where: { id: payment.orderId },
            data: {
              status: OrderStatus.EXPIRED,
              canceledAt: new Date(),
            },
          });
        }
      });
    }

    // Marca o evento como processado
    await prisma.webhookEvent.update({
      where: { eventId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info({ eventId, paymentId, mappedStatus }, 'Webhook processado com sucesso.');
  } catch (error) {
    // Em caso de erro, marca como FAILED e permite reprocessamento futuro
    await prisma.webhookEvent.update({
      where: { eventId },
      data: { status: 'FAILED', errorMessage: String(error) },
    });
    logger.error({ error, eventId }, 'Erro ao processar webhook');
    throw error;
  }
}

/**
 * Mapeia o status retornado pelo Mercado Pago para o enum PaymentStatus.
 */
function mapMercadoPagoStatusToPaymentStatus(
  mpStatus: string
): PaymentStatus {
  switch (mpStatus) {
    case 'approved':
      return PaymentStatus.APPROVED;
    case 'rejected':
      return PaymentStatus.REJECTED;
    case 'cancelled':
      return PaymentStatus.CANCELED;
    case 'expired':
      return PaymentStatus.EXPIRED;
    case 'pending':
    case 'in_process':
    default:
      return PaymentStatus.PENDING;
  }
}
