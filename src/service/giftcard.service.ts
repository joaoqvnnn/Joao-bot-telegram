import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { GiftCardStatus, Prisma, TransactionType } from '@prisma/client';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface CreateGiftCardInput {
  initialValue: number;
  expiresAt?: Date;
  createdByUserId?: number;
}

interface RedeemGiftCardInput {
  code: string;
  userId: number;
}

// ==============================================
// FUNÇÕES PÚBLICAS
// ==============================================

/**
 * Gera um novo Gift Card com código único.
 * - Tenta criar com código aleatório; em caso de colisão (unique constraint), tenta novamente.
 * - Retorna o GiftCard criado.
 */
export async function createGiftCard(
  input: CreateGiftCardInput
): Promise<Prisma.GiftCardGetPayload<{}>> {
  const { initialValue, expiresAt, createdByUserId } = input;

  if (initialValue <= 0) {
    throw new Error('Valor do gift card deve ser positivo');
  }

  const maxAttempts = 10;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const code = generateGiftCardCode();

    try {
      const giftCard = await prisma.giftCard.create({
        data: {
          code,
          initialValue,
          remainingValue: initialValue,
          status: GiftCardStatus.ACTIVE,
          expiresAt: expiresAt || null,
          createdByUserId: createdByUserId || null,
        },
      });

      logger.info({ giftCardId: giftCard.id, code }, 'Gift card criado.');
      return giftCard;
    } catch (error: any) {
      // Se for violação de unicidade do código, tenta gerar outro
      if (error?.code === 'P2002') {
        logger.warn(`Código ${code} já existe, tentando novamente...`);
        continue;
      }
      // Outro erro: lança
      logger.error({ error }, 'Erro ao criar gift card');
      throw new Error('Falha ao criar gift card. Tente novamente.');
    }
  }

  throw new Error('Não foi possível gerar um código único para o gift card após várias tentativas.');
}

/**
 * Busca um Gift Card pelo código, sem alterar nada.
 * Retorna o GiftCard ou null se não encontrado.
 */
export async function getGiftCardByCode(
  code: string
): Promise<Prisma.GiftCardGetPayload<{}> | null> {
  return prisma.giftCard.findUnique({
    where: { code },
  });
}

/**
 * Valida se um Gift Card pode ser resgatado.
 * ATENÇÃO: Esta função é apenas informativa para exibição. Para resgate real,
 * utilize `redeemGiftCard`, que faz a validação dentro de transação atômica.
 * Esta função NÃO deve ser usada para autorizar operações, pois pode haver corrida.
 */
export async function validateGiftCard(code: string): Promise<Prisma.GiftCardGetPayload<{}>> {
  const giftCard = await prisma.giftCard.findUnique({
    where: { code },
  });

  if (!giftCard) {
    throw new Error('Gift card não encontrado.');
  }

  if (giftCard.status !== GiftCardStatus.ACTIVE) {
    throw new Error('Gift card não está ativo.');
  }

  if (giftCard.expiresAt && giftCard.expiresAt < new Date()) {
    // Atualiza status para EXPIRED se ainda estava ACTIVE
    if (giftCard.status === GiftCardStatus.ACTIVE) {
      await prisma.giftCard.update({
        where: { id: giftCard.id },
        data: { status: GiftCardStatus.EXPIRED },
      });
    }
    throw new Error('Gift card expirado.');
  }

  return giftCard;
}

/**
 * Resgata um Gift Card para um usuário, adicionando o valor ao saldo.
 * 
 * Corrige os pontos levantados:
 * - Transação atômica que inclui validação de status/expiração e atualização do gift card.
 * - Proteção contra concorrência via `updateMany` condicional (evita duplicação).
 * - Saldo auditado correto (balanceBefore e balanceAfter obtidos antes e depois do incremento).
 * - Sem busca duplicada: tudo resolvido na mesma transação com uma única busca.
 * 
 * Idempotente: se o gift card já estiver USED, DISABLED ou EXPIRED, lança erro; não duplica saldo.
 */
export async function redeemGiftCard(
  input: RedeemGiftCardInput
): Promise<Prisma.GiftCardGetPayload<{}>> {
  const { code, userId } = input;

  try {
    return await prisma.$transaction(async (tx) => {
      // Busca o gift card pelo código UMA vez dentro da transação
      const giftCard = await tx.giftCard.findUnique({
        where: { code },
      });

      if (!giftCard) {
        throw new Error('Gift card não encontrado.');
      }

      // Verificação de expiração dentro da transação (evita corrida)
      if (giftCard.expiresAt && giftCard.expiresAt < new Date()) {
        // Se ainda estava ACTIVE, marca como EXPIRED
        if (giftCard.status === GiftCardStatus.ACTIVE) {
          await tx.giftCard.update({
            where: { id: giftCard.id },
            data: { status: GiftCardStatus.EXPIRED, updatedAt: new Date() },
          });
        }
        throw new Error('Gift card expirado.');
      }

      // Verificação de status: somente ACTIVE pode ser resgatado
      if (giftCard.status !== GiftCardStatus.ACTIVE) {
        throw new Error('Gift card não está ativo.');
      }

      // Tenta marcar como USED de forma condicional (proteção contra concorrência)
      const updateResult = await tx.giftCard.updateMany({
        where: {
          id: giftCard.id,
          status: GiftCardStatus.ACTIVE, // condição crucial: só atualiza se ainda estiver ACTIVE
        },
        data: {
          status: GiftCardStatus.USED,
          usedByUserId: userId,
          usedAt: new Date(),
          remainingValue: 0, // consumido integralmente
          updatedAt: new Date(),
        },
      });

      // Se count === 0, outro processo resgatou entre a leitura e a atualização
      if (updateResult.count === 0) {
        throw new Error('Gift card já foi utilizado ou não está mais ativo.');
      }

      // Obter saldo do usuário ANTES do incremento (auditoria correta)
      const userBefore = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      if (!userBefore) {
        throw new Error('Usuário não encontrado.');
      }
      const balanceBefore = userBefore.balance;

      // Incrementa o saldo do usuário e obtém o saldo APÓS
      const userAfter = await tx.user.update({
        where: { id: userId },
        data: {
          balance: { increment: giftCard.remainingValue },
        },
        select: { balance: true },
      });
      const balanceAfter = userAfter.balance;

      // Cria transação de crédito com saldos corretos
      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.CREDIT,
          amount: giftCard.remainingValue,
          balanceBefore,
          balanceAfter,
          description: `Resgate de Gift Card ${giftCard.code}`,
          referenceId: giftCard.id,
          referenceType: 'gift_card',
        },
      });

      logger.info(
        { giftCardId: giftCard.id, userId, value: giftCard.remainingValue, balanceBefore, balanceAfter },
        'Gift card resgatado com sucesso.'
      );

      // Retorna o gift card atualizado
      return tx.giftCard.findUnique({
        where: { id: giftCard.id },
      }) as Promise<Prisma.GiftCardGetPayload<{}>>;
    });
  } catch (error) {
    logger.error({ error, code, userId }, 'Erro ao resgatar gift card');
    throw error;
  }
}

/**
 * Desativa um Gift Card manualmente (admin).
 */
export async function disableGiftCard(giftCardId: number): Promise<void> {
  const giftCard = await prisma.giftCard.findUnique({
    where: { id: giftCardId },
  });

  if (!giftCard) {
    throw new Error('Gift card não encontrado.');
  }

  if (giftCard.status === GiftCardStatus.ACTIVE) {
    await prisma.giftCard.update({
      where: { id: giftCardId },
      data: { status: GiftCardStatus.DISABLED, updatedAt: new Date() },
    });
    logger.info({ giftCardId }, 'Gift card desativado.');
  } else {
    logger.warn({ giftCardId, status: giftCard.status }, 'Tentativa de desativar gift card não ativo.');
  }
}

/**
 * Gera um código único para gift card.
 * Formato: XXXX-XXXX-XXXX-XXXX (16 caracteres alfanuméricos maiúsculos).
 */
function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = 4;
  const segmentLength = 4;
  let code = '';
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segmentLength; j++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (i < segments - 1) code += '-';
  }
  return code;
}
