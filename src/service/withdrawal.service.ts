import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import {
  WithdrawalStatus,
  TransactionType,
  Prisma,
} from '@prisma/client';
import { env } from '../config/env';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface RequestWithdrawalInput {
  userId: number;
  amount: number;
  pixKey: string;
  idempotencyKey: string;
}

// ==============================================
// VALIDAÇÃO DE CHAVE PIX
// ==============================================

function validatePixKey(pixKey: string): void {
  const trimmed = pixKey.trim();

  const cpfRegex = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
  if (cpfRegex.test(trimmed)) return;

  const cnpjRegex = /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/;
  if (cnpjRegex.test(trimmed)) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(trimmed)) return;

  const phoneRegex = /^\+\d{1,3}\d{10,11}$/;
  if (phoneRegex.test(trimmed)) return;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) return;

  throw new Error('Chave Pix inválida. Informe um CPF, CNPJ, e-mail, telefone ou chave aleatória (UUID) válida.');
}

// ==============================================
// FUNÇÕES INTERNAS (Mercado Pago)
// ==============================================

async function createPayout(
  amount: number,
  pixKey: string,
  description: string,
  idempotencyKey: string
): Promise<any> {
  const accessToken = env.payout.accessToken;
  const url = 'https://api.mercadopago.com/v1/payouts';
  const body = {
    amount,
    description,
    payment_method_id: 'pix',
    receiver_data: {
      type: 'pix',
      data: {
        pix_key: pixKey,
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    logger.error({ networkError, idempotencyKey }, 'Erro de rede ao criar payout');
    throw new Error('NETWORK_ERROR');
  }

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok) {
    logger.error(
      { status: response.status, responseData, idempotencyKey },
      'Erro na criação de payout no Mercado Pago'
    );
    if (response.status >= 400 && response.status < 500) {
      throw new Error(`BUSINESS_ERROR: ${JSON.stringify(responseData)}`);
    } else {
      throw new Error('TEMPORARY_ERROR');
    }
  }

  return responseData;
}

async function getPayoutStatus(externalId: string): Promise<any> {
  const accessToken = env.payout.accessToken;
  const url = `https://api.mercadopago.com/v1/payouts/${externalId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    logger.error({ status: response.status, errorData }, 'Erro ao consultar payout no Mercado Pago');
    throw new Error(`Falha na API do Mercado Pago: ${response.status} ${JSON.stringify(errorData)}`);
  }

  return response.json();
}

function mapPayoutStatusToWithdrawalStatus(mpStatus: string): WithdrawalStatus {
  switch (mpStatus) {
    case 'approved':
    case 'completed':
    case 'done':
      return WithdrawalStatus.COMPLETED;
    case 'rejected':
    case 'cancelled':
    case 'failed':
      return WithdrawalStatus.FAILED;
    case 'in_process':
    case 'pending':
      return WithdrawalStatus.PROCESSING;
    default:
      return WithdrawalStatus.PENDING;
  }
}

// ==============================================
// FUNÇÃO DE PROCESSAMENTO DO PAYOUT
// ==============================================

async function processPayoutCreation(withdrawalId: number): Promise<void> {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  if (!withdrawal) {
    throw new Error('Saque não encontrado.');
  }

  if (withdrawal.externalId) {
    return;
  }

  if (!withdrawal.idempotencyKey) {
    throw new Error('Saque sem chave de idempotência, não é possível criar payout.');
  }

  try {
    const payoutResponse = await createPayout(
      withdrawal.amount.toNumber(),
      withdrawal.pixKey,
      `Saque do usuário ${withdrawal.userId}`,
      withdrawal.idempotencyKey
    );

    const externalId = String(payoutResponse.id);
    const mappedStatus = mapPayoutStatusToWithdrawalStatus(payoutResponse.status || 'pending');

    await prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        externalId,
        status: mappedStatus,
        processedAt: mappedStatus === WithdrawalStatus.COMPLETED ? new Date() : null,
        failureReason: mappedStatus === WithdrawalStatus.FAILED ? (payoutResponse.status_detail || null) : null,
      },
    });

    logger.info(
      { withdrawalId, externalId, status: mappedStatus },
      'Payout criado e saque atualizado com sucesso.'
    );
  } catch (error: any) {
    if (error.message.startsWith('BUSINESS_ERROR')) {
      logger.error({ error, withdrawalId }, 'Erro de negócio na criação do payout, revertendo.');
      await revertWithdrawal(withdrawalId, error.message);
      throw new Error('Não foi possível processar o saque: ' + error.message);
    } else if (error.message === 'TEMPORARY_ERROR' || error.message === 'NETWORK_ERROR') {
      logger.warn({ error, withdrawalId }, 'Erro temporário na criação do payout. Saque permanece pendente para retry.');
      await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.PROCESSING },
      });
      throw new Error('Erro temporário ao processar saque. Tente novamente mais tarde.');
    } else {
      logger.error({ error, withdrawalId }, 'Erro desconhecido na criação do payout.');
      throw error;
    }
  }
}

async function revertWithdrawal(withdrawalId: number, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: withdrawalId },
    });

    if (!withdrawal) {
      throw new Error('Saque não encontrado para reversão.');
    }

    if (withdrawal.status === WithdrawalStatus.FAILED || withdrawal.status === WithdrawalStatus.CANCELED) {
      logger.warn({ withdrawalId }, 'Saque já revertido, ignorando.');
      return;
    }

    const user = await tx.user.findUnique({
      where: { id: withdrawal.userId },
      select: { balance: true },
    });
    if (!user) throw new Error('Usuário não encontrado.');

    const balanceBefore = user.balance;
    await tx.user.update({
      where: { id: withdrawal.userId },
      data: { balance: { increment: withdrawal.amount } },
    });
    const userAfter = await tx.user.findUnique({
      where: { id: withdrawal.userId },
      select: { balance: true },
    });
    const balanceAfter = userAfter!.balance;

    await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.FAILED,
        failureReason: reason,
        processedAt: new Date(),
      },
    });

    await tx.transaction.create({
      data: {
        userId: withdrawal.userId,
        type: TransactionType.CREDIT,
        amount: withdrawal.amount,
        balanceBefore,
        balanceAfter,
        description: `Estorno de saque falho (${withdrawal.id})`,
        referenceId: withdrawal.id,
        referenceType: 'withdrawal',
      },
    });
  });
  logger.info({ withdrawalId }, 'Saque revertido e saldo devolvido.');
}

// ==============================================
// FUNÇÃO PRINCIPAL: SOLICITAR SAQUE
// ==============================================

export async function requestWithdrawal(
  input: RequestWithdrawalInput
): Promise<Prisma.WithdrawalGetPayload<{}>> {
  const { userId, amount, pixKey, idempotencyKey } = input;

  if (amount <= 0) {
    throw new Error('Valor do saque deve ser maior que zero.');
  }
  validatePixKey(pixKey);
  if (!idempotencyKey) {
    throw new Error('Chave de idempotência é obrigatória.');
  }

  const amountDecimal = new Prisma.Decimal(amount.toFixed(2));

  const existingWithdrawal = await prisma.withdrawal.findUnique({
    where: { idempotencyKey },
  });
  if (existingWithdrawal) {
    logger.info(
      { withdrawalId: existingWithdrawal.id, idempotencyKey },
      'Saque duplicado detectado, retornando existente.'
    );
    return existingWithdrawal;
  }

  let withdrawal: Prisma.WithdrawalGetPayload<{}>;

  try {
    withdrawal = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });

      if (!user) {
        throw new Error('Usuário não encontrado.');
      }

      const balanceBefore = user.balance;
      if (balanceBefore.lessThan(amountDecimal)) {
        throw new Error('Saldo insuficiente para o saque.');
      }

      const updatedUser = await tx.user.updateMany({
        where: {
          id: userId,
          balance: { gte: amountDecimal },
        },
        data: {
          balance: { decrement: amountDecimal },
        },
      });

      if (updatedUser.count === 0) {
        throw new Error('Saldo insuficiente ou usuário não encontrado.');
      }

      const userAfter = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      const balanceAfter = userAfter!.balance;

      const newWithdrawal = await tx.withdrawal.create({
        data: {
          userId,
          amount: amountDecimal,
          status: WithdrawalStatus.PENDING,
          pixKey,
          idempotencyKey,
        },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.DEBIT,
          amount: amountDecimal,
          balanceBefore,
          balanceAfter,
          description: `Saque solicitado (${pixKey})`,
          referenceId: newWithdrawal.id,
          referenceType: 'withdrawal',
        },
      });

      logger.info(
        { withdrawalId: newWithdrawal.id, userId, amount: amountDecimal.toString() },
        'Saque solicitado e saldo debitado.'
      );

      return newWithdrawal;
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const existing = await prisma.withdrawal.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        logger.warn('Concorrência de idempotência detectada, retornando existente.');
        return existing;
      }
    }
    logger.error({ error, userId, amount }, 'Erro ao solicitar saque');
    throw error;
  }

  try {
    await processPayoutCreation(withdrawal.id);
  } catch (error) {
    logger.error({ error, withdrawalId: withdrawal.id }, 'Falha no processamento do payout');
    throw error;
  }

  return prisma.withdrawal.findUnique({ where: { id: withdrawal.id } }) as Promise<Prisma.WithdrawalGetPayload<{}>>;
}

// ==============================================
// ATUALIZAÇÃO DE STATUS (com estorno se necessário)
// ==============================================

export async function checkWithdrawalStatus(
  withdrawalId: number
): Promise<Prisma.WithdrawalGetPayload<{}>> {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  if (!withdrawal) {
    throw new Error('Saque não encontrado.');
  }

  if (
    withdrawal.status === WithdrawalStatus.COMPLETED ||
    withdrawal.status === WithdrawalStatus.FAILED ||
    withdrawal.status === WithdrawalStatus.CANCELED
  ) {
    return withdrawal;
  }

  if (!withdrawal.externalId && withdrawal.idempotencyKey) {
    try {
      await processPayoutCreation(withdrawalId);
    } catch (error) {
      logger.warn({ error, withdrawalId }, 'Falha ao tentar criar payout durante verificação.');
      return prisma.withdrawal.findUnique({ where: { id: withdrawalId } }) as Promise<Prisma.WithdrawalGetPayload<{}>>;
    }
  }

  const updatedWithdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });
  if (!updatedWithdrawal || !updatedWithdrawal.externalId) {
    return updatedWithdrawal as Prisma.WithdrawalGetPayload<{}>;
  }

  try {
    const payoutData = await getPayoutStatus(updatedWithdrawal.externalId);
    const mappedStatus = mapPayoutStatusToWithdrawalStatus(payoutData.status || 'pending');

    if (mappedStatus === WithdrawalStatus.FAILED && updatedWithdrawal.status !== WithdrawalStatus.FAILED) {
      await revertWithdrawal(withdrawalId, payoutData.status_detail || 'Payout falhou no provedor');
      return prisma.withdrawal.findUnique({ where: { id: withdrawalId } }) as Promise<Prisma.WithdrawalGetPayload<{}>>;
    }

    if (mappedStatus !== updatedWithdrawal.status) {
      const final = await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: mappedStatus,
          processedAt: mappedStatus === WithdrawalStatus.COMPLETED ? new Date() : null,
          failureReason: mappedStatus === WithdrawalStatus.FAILED ? (payoutData.status_detail || null) : null,
        },
      });
      logger.info(
        { withdrawalId, oldStatus: updatedWithdrawal.status, newStatus: mappedStatus },
        'Status de saque atualizado.'
      );
      return final;
    }

    return updatedWithdrawal;
  } catch (error) {
    logger.error({ error, withdrawalId }, 'Erro ao consultar status do saque');
    throw error;
  }
}

// ==============================================
// CANCELAMENTO DE SAQUE PENDENTE (blindado com updateMany)
// ==============================================

export async function cancelWithdrawal(withdrawalId: number): Promise<Prisma.WithdrawalGetPayload<{}>> {
  // Tenta marcar como CANCELED de forma condicional, evitando corrida
  const updateResult = await prisma.withdrawal.updateMany({
    where: {
      id: withdrawalId,
      status: WithdrawalStatus.PENDING,
      externalId: null,
    },
    data: {
      status: WithdrawalStatus.CANCELED,
      processedAt: new Date(),
    },
  });

  if (updateResult.count === 0) {
    // Se não atualizou, verifica o motivo
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!withdrawal) {
      throw new Error('Saque não encontrado.');
    }
    if (withdrawal.status !== WithdrawalStatus.PENDING || withdrawal.externalId) {
      throw new Error('Somente saques pendentes sem processamento externo podem ser cancelados.');
    }
    // Se chegou aqui, é um caso raro de corrida; trata como erro genérico
    throw new Error('Não foi possível cancelar o saque devido a uma atualização concorrente.');
  }

  // Recarrega o saque para obter dados atualizados
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal) {
    throw new Error('Saque não encontrado após cancelamento.');
  }

  // Devolve o saldo e registra transação (separadamente, mas idealmente em transação)
  try {
    await prisma.$transaction(async (tx) => {
      const userBefore = await tx.user.findUnique({
        where: { id: withdrawal.userId },
        select: { balance: true },
      });
      const balanceBefore = userBefore!.balance;

      await tx.user.update({
        where: { id: withdrawal.userId },
        data: { balance: { increment: withdrawal.amount } },
      });

      const userAfter = await tx.user.findUnique({
        where: { id: withdrawal.userId },
        select: { balance: true },
      });
      const balanceAfter = userAfter!.balance;

      await tx.transaction.create({
        data: {
          userId: withdrawal.userId,
          type: TransactionType.CREDIT,
          amount: withdrawal.amount,
          balanceBefore,
          balanceAfter,
          description: `Cancelamento de saque (${withdrawal.id})`,
          referenceId: withdrawal.id,
          referenceType: 'withdrawal',
        },
      });
    });
    logger.info({ withdrawalId }, 'Saque cancelado e saldo devolvido.');
  } catch (error) {
    logger.error({ error, withdrawalId }, 'Erro ao devolver saldo após cancelamento');
    // Se falhar aqui, o saque já está CANCELED, mas o saldo não foi devolvido.
    // Necessário intervenção para compensar.
    throw new Error('Falha ao devolver saldo. Contate o suporte.');
  }

  return withdrawal;
}

export async function getWithdrawalById(
  withdrawalId: number
): Promise<Prisma.WithdrawalGetPayload<{}> | null> {
  return prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });
}
