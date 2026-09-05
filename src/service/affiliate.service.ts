import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { AffiliateCommissionStatus, Prisma, TransactionType } from '@prisma/client';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface CreateAffiliateInput {
  userId: number;
  commissionPercent?: number; // padrão 5%
}

interface RecordClickInput {
  affiliateId: number;
  clickedByUserId?: number;
  ipAddress?: string;
  userAgent?: string;
}

interface ProcessCommissionInput {
  orderId: number;
  affiliateId: number;
  // Removido orderTotal – passaremos a buscar o total real da order no banco
}

// ==============================================
// FUNÇÕES PÚBLICAS
// ==============================================

/**
 * Cria um registro de afiliado para um usuário.
 * - Verifica se o usuário existe.
 * - Gera um código único (tenta até 10 vezes em caso de colisão).
 * - Retorna o Affiliate criado.
 */
export async function createAffiliate(
  input: CreateAffiliateInput
): Promise<Prisma.AffiliateGetPayload<{}>> {
  const { userId, commissionPercent = 5 } = input;

  // Verifica se o usuário existe
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    throw new Error('Usuário não encontrado.');
  }

  // Verifica se já é afiliado
  const existingAffiliate = await prisma.affiliate.findUnique({
    where: { userId },
  });
  if (existingAffiliate) {
    throw new Error('Usuário já é afiliado.');
  }

  const maxAttempts = 10;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const code = generateAffiliateCode();

    try {
      const affiliate = await prisma.affiliate.create({
        data: {
          userId,
          code,
          commissionPercent,
        },
      });
      logger.info({ affiliateId: affiliate.id, userId, code }, 'Afiliado criado.');
      return affiliate;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        // Se a violação for no campo userId, não adianta tentar de novo
        if (error?.meta?.target?.includes('userId')) {
          throw new Error('Usuário já é afiliado.');
        }
        logger.warn(`Código ${code} já existe, tentando novamente...`);
        continue;
      }
      logger.error({ error, userId }, 'Erro ao criar afiliado');
      throw new Error('Falha ao criar afiliado.');
    }
  }

  throw new Error('Não foi possível gerar um código único para o afiliado.');
}

/**
 * Busca um afiliado pelo código.
 */
export async function getAffiliateByCode(
  code: string
): Promise<Prisma.AffiliateGetPayload<{}> | null> {
  return prisma.affiliate.findUnique({
    where: { code },
  });
}

/**
 * Busca um afiliado pelo ID do usuário.
 */
export async function getAffiliateByUserId(
  userId: number
): Promise<Prisma.AffiliateGetPayload<{}> | null> {
  return prisma.affiliate.findUnique({
    where: { userId },
  });
}

/**
 * Registra um clique em um link de afiliado.
 * - Idempotente? Não precisa, pois cada clique é um evento real.
 * - Armazena IP e user agent se fornecidos.
 */
export async function recordClick(input: RecordClickInput): Promise<void> {
  const { affiliateId, clickedByUserId, ipAddress, userAgent } = input;

  try {
    await prisma.affiliateClick.create({
      data: {
        affiliateId,
        clickedByUserId: clickedByUserId || null,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      },
    });
    logger.info({ affiliateId, clickedByUserId }, 'Clique de afiliado registrado.');
  } catch (error) {
    logger.error({ error, affiliateId }, 'Erro ao registrar clique');
    throw new Error('Falha ao registrar clique.');
  }
}

/**
 * Processa a comissão de um pedido pago para um determinado afiliado.
 * 
 * Correções implementadas:
 * - Busca o total real do pedido dentro da transação (não aceita valor de fora).
 * - Calcula o valor da comissão usando Decimal (precisão de centavos).
 * - Cria registro de Transaction (livro-caixa) para auditoria do saldo do afiliado.
 * - Idempotente e protegido contra duplicação (verificação + constraint única).
 */
export async function processCommission(
  input: ProcessCommissionInput
): Promise<Prisma.CommissionGetPayload<{}> | null> {
  const { orderId, affiliateId } = input;

  try {
    // Transação completa: busca da order, cálculo, criação da comissão,
    // atualização do afiliado e criação da transação de auditoria.
    return await prisma.$transaction(async (tx) => {
      // 1. Verifica se a comissão já existe (idempotência)
      const existingCommission = await tx.commission.findFirst({
        where: { orderId, affiliateId },
      });
      if (existingCommission) {
        logger.info(
          { orderId, affiliateId, commissionId: existingCommission.id },
          'Comissão já processada para este pedido e afiliado.'
        );
        return existingCommission;
      }

      // 2. Busca o afiliado
      const affiliate = await tx.affiliate.findUnique({
        where: { id: affiliateId },
      });
      if (!affiliate) {
        throw new Error('Afiliado não encontrado.');
      }

      // 3. Busca o pedido para obter o total real
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { total: true, status: true },
      });
      if (!order) {
        throw new Error('Pedido não encontrado.');
      }

      // Garante que o pedido esteja pago? (pode ser opcional, mas recomendável)
      // Se necessário, valide: if (order.status !== 'PAID') throw new Error('Pedido não está pago.');

      const orderTotal = order.total; // Decimal

      // 4. Calcula a comissão com precisão decimal
      // affiliate.commissionPercent é Decimal (ex: 5.00)
      // amount = orderTotal * commissionPercent / 100
      const amount = orderTotal
        .mul(affiliate.commissionPercent)
        .div(100)
        .toDecimalPlaces(2); // arredonda para centavos

      // 5. Cria a comissão
      const commission = await tx.commission.create({
        data: {
          affiliateId,
          orderId,
          amount,
          status: AffiliateCommissionStatus.PENDING,
        },
      });

      // 6. Atualiza o saldo e total ganho do afiliado (incremento decimal)
      const updatedAffiliate = await tx.affiliate.update({
        where: { id: affiliateId },
        data: {
          totalEarned: { increment: amount },
          balance: { increment: amount },
        },
        select: { balance: true, totalEarned: true },
      });

      // 7. Cria a transação de auditoria (livro-caixa do afiliado)
      // Observação: Transaction está ligada ao usuário (userId).
      // Usaremos o userId do afiliado, e os campos balanceBefore/balanceAfter
      // refletirão o saldo do afiliado (não o saldo da carteira normal).
      await tx.transaction.create({
        data: {
          userId: affiliate.userId,
          type: TransactionType.CREDIT,
          amount,
          balanceBefore: affiliate.balance,      // saldo do afiliado antes
          balanceAfter: updatedAffiliate.balance, // saldo do afiliado depois
          description: `Comissão de afiliado pedido #${orderId}`,
          referenceId: commission.id,
          referenceType: 'affiliate_commission',
        },
      });

      logger.info(
        { commissionId: commission.id, orderId, affiliateId, amount: amount.toString() },
        'Comissão processada e registrada no livro-caixa.'
      );

      return commission;
    });
  } catch (error: any) {
    // Se houver violação de unicidade (P2002) durante a criação, pode ser que outra
    // transação tenha criado a comissão simultaneamente. Nesse caso, tenta buscar a existente.
    if (error?.code === 'P2002') {
      const existing = await prisma.commission.findFirst({
        where: { orderId, affiliateId },
      });
      if (existing) {
        logger.warn(
          { orderId, affiliateId, commissionId: existing.id },
          'Comissão duplicada detectada e resolvida pela constraint única.'
        );
        return existing;
      }
    }
    logger.error({ error, orderId, affiliateId }, 'Erro ao processar comissão');
    throw error;
  }
}

/**
 * Marca uma comissão como paga (quando o afiliado solicitar saque e for efetuado).
 * - Idempotente e protegida contra concorrência: usa updateMany condicional.
 */
export async function markCommissionAsPaid(
  commissionId: number
): Promise<void> {
  // Tenta atualizar somente se ainda estiver PENDING
  const updateResult = await prisma.commission.updateMany({
    where: {
      id: commissionId,
      status: AffiliateCommissionStatus.PENDING,
    },
    data: {
      status: AffiliateCommissionStatus.PAID,
      paidAt: new Date(),
    },
  });

  if (updateResult.count === 0) {
    // Se nenhuma linha foi atualizada, pode ser que já estava paga ou não existe
    const commission = await prisma.commission.findUnique({
      where: { id: commissionId },
      select: { status: true },
    });
    if (commission?.status === AffiliateCommissionStatus.PAID) {
      logger.warn({ commissionId }, 'Comissão já está paga.');
      return;
    }
    throw new Error('Comissão não encontrada ou não pode ser marcada como paga.');
  }

  logger.info({ commissionId }, 'Comissão marcada como paga.');
}

/**
 * Atualiza o percentual de comissão de um afiliado (admin).
 * - Sempre obtém o valor mais recente do afiliado e atualiza.
 */
export async function updateCommissionPercent(
  affiliateId: number,
  newPercent: number
): Promise<Prisma.AffiliateGetPayload<{}>> {
  if (newPercent < 0 || newPercent > 100) {
    throw new Error('Percentual deve estar entre 0 e 100.');
  }

  try {
    const updated = await prisma.affiliate.update({
      where: { id: affiliateId },
      data: { commissionPercent: newPercent },
    });
    logger.info({ affiliateId, newPercent }, 'Percentual de comissão atualizado.');
    return updated;
  } catch (error: any) {
    if (error?.code === 'P2025') {
      throw new Error('Afiliado não encontrado.');
    }
    logger.error({ error, affiliateId }, 'Erro ao atualizar percentual');
    throw error;
  }
}

/**
 * Gera um código de afiliado único (ex: AF-XXXXXXXX).
 */
function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const length = 8;
  let code = 'AF-';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
