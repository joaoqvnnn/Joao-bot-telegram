import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { BlockStatus, BlockType, Prisma } from '@prisma/client';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface CreateBlockInput {
  userId: number;
  type?: BlockType;
  reason?: string;
  durationMinutes?: number;
}

// ==============================================
// FUNÇÕES PÚBLICAS
// ==============================================

/**
 * Cria um bloqueio para um usuário.
 * - Usa transação com isolamento serializável para impedir criação duplicada
 *   do mesmo tipo de bloqueio ativo em condições de corrida.
 * - Se já existir bloqueio ativo do mesmo tipo (não expirado ou permanente),
 *   retorna o existente (idempotente).
 * - Regra: se existir bloqueio ativo, o novo é ignorado (permanece o existente).
 */
export async function createBlock(
  input: CreateBlockInput
): Promise<Prisma.BlockGetPayload<{}>> {
  const { userId, type = BlockType.PAYMENT_ATTEMPT, reason, durationMinutes } = input;

  const now = new Date();
  const endsAt =
    durationMinutes && durationMinutes > 0
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;

  try {
    // Transação serializável para evitar corrida
    return await prisma.$transaction(
      async (tx) => {
        // Re-verifica dentro da transação
        const existingActive = await tx.block.findFirst({
          where: {
            userId,
            type,
            status: BlockStatus.ACTIVE,
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
          orderBy: { startsAt: 'desc' },
        });

        if (existingActive) {
          logger.info(
            { blockId: existingActive.id, userId, type },
            'Bloqueio ativo do mesmo tipo já existe, reutilizando.'
          );
          return existingActive;
        }

        // Cria o novo bloqueio
        const block = await tx.block.create({
          data: {
            userId,
            type,
            status: BlockStatus.ACTIVE,
            reason: reason || null,
            startsAt: new Date(),
            endsAt,
          },
        });

        logger.info(
          { blockId: block.id, userId, type, endsAt },
          'Bloqueio criado com sucesso.'
        );
        return block;
      },
      { isolationLevel: 'Serializable' }
    );
  } catch (error: any) {
    // Se a transação serializável for abortada por concorrência, tenta recarregar o bloqueio existente
    if (error?.code === 'P2034' || error?.message?.includes('could not serialize access')) {
      logger.warn('Concorrência na criação de bloqueio, tentando recuperar bloqueio existente.');
      const existing = await prisma.block.findFirst({
        where: {
          userId,
          type,
          status: BlockStatus.ACTIVE,
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        },
      });
      if (existing) {
        return existing;
      }
    }
    logger.error({ error, userId, type }, 'Erro ao criar bloqueio');
    throw new Error('Falha ao criar bloqueio.');
  }
}

/**
 * Verifica se um usuário está bloqueado (opcionalmente por tipo).
 * - Não expira bloqueios inline (manutenção separada).
 * - Retorna o bloqueio ativo mais recente do tipo indicado (ou de qualquer tipo, se type não informado).
 * - Considera apenas bloqueios com status ACTIVE e não expirados (endsAt > now ou null).
 */
export async function getActiveBlock(
  userId: number,
  type?: BlockType
): Promise<Prisma.BlockGetPayload<{}> | null> {
  const now = new Date();

  const whereClause: Prisma.BlockWhereInput = {
    userId,
    status: BlockStatus.ACTIVE,
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };

  if (type) {
    whereClause.type = type;
  }

  return prisma.block.findFirst({
    where: whereClause,
    orderBy: { startsAt: 'desc' },
  });
}

/**
 * Expira bloqueios antigos (deve ser chamado periodicamente por um job/cron).
 * - Atualiza em massa todos os bloqueios ACTIVE com endsAt < now para EXPIRED.
 * - Retorna a quantidade de registros alterados.
 */
export async function expireOldBlocks(): Promise<number> {
  const now = new Date();
  const result = await prisma.block.updateMany({
    where: {
      status: BlockStatus.ACTIVE,
      endsAt: { lt: now },
    },
    data: {
      status: BlockStatus.EXPIRED,
      updatedAt: new Date(),
    },
  });

  if (result.count > 0) {
    logger.info(`Expiraram ${result.count} bloqueio(s) automaticamente.`);
  }
  return result.count;
}

/**
 * Remove manualmente um bloqueio ativo (admin).
 * - Marca o status como REMOVED.
 * - Idempotente: se não estiver ativo, não faz nada.
 */
export async function removeBlock(blockId: number): Promise<void> {
  const updateResult = await prisma.block.updateMany({
    where: {
      id: blockId,
      status: BlockStatus.ACTIVE,
    },
    data: {
      status: BlockStatus.REMOVED,
      updatedAt: new Date(),
    },
  });

  if (updateResult.count === 0) {
    const block = await prisma.block.findUnique({
      where: { id: blockId },
      select: { status: true },
    });
    if (!block) {
      throw new Error('Bloqueio não encontrado.');
    }
    logger.warn({ blockId, status: block.status }, 'Bloqueio não está ativo, nada a fazer.');
    return;
  }

  logger.info({ blockId }, 'Bloqueio removido com sucesso.');
}

/**
 * Verifica se o usuário pode executar uma ação (ex: tentar pagamento, saque).
 * - Aceita um tipo de bloqueio opcional para verificação específica.
 * - Retorna true se não houver bloqueio ativo do tipo informado.
 */
export async function isUserBlocked(
  userId: number,
  type?: BlockType
): Promise<boolean> {
  const activeBlock = await getActiveBlock(userId, type);
  return activeBlock !== null;
}

/**
 * Obtém todos os bloqueios de um usuário (histórico completo).
 */
export async function getUserBlocks(
  userId: number
): Promise<Prisma.BlockGetPayload<{}>[]> {
  return prisma.block.findMany({
    where: { userId },
    orderBy: { startsAt: 'desc' },
  });
}
