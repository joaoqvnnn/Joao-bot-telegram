import { Bot, Context } from 'grammy';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { Prisma, BlockType } from '@prisma/client';
import { createOrder, getOrderById } from '../services/order.service';
import { redeemGiftCard } from '../services/giftcard.service';
import { requestWithdrawal, getWithdrawalById } from '../services/withdrawal.service';
import { getAffiliateByUserId, createAffiliate, getAffiliateByCode } from '../services/affiliate.service';
import { isUserBlocked } from '../services/block.service';
import { randomUUID } from 'crypto';

// ==============================================
// AUXILIAR: OBTER OU CRIAR USUÁRIO
// ==============================================

async function getOrCreateUser(
  telegramId: number,
  username?: string,
  firstName?: string,
  lastName?: string
): Promise<Prisma.UserGetPayload<{}>> {
  const tgId = BigInt(telegramId);

  let user = await prisma.user.findUnique({
    where: { telegramId: tgId },
  });

  if (user) {
    if (
      user.username !== username ||
      user.firstName !== firstName ||
      user.lastName !== lastName
    ) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          username: username || user.username,
          firstName: firstName || user.firstName,
          lastName: lastName || user.lastName,
        },
      });
    }
    return user;
  }

  try {
    user = await prisma.user.create({
      data: {
        telegramId: tgId,
        username: username || null,
        firstName: firstName || null,
        lastName: lastName || null,
      },
    });
    return user;
  } catch (error: any) {
    if (error?.code === 'P2002') {
      user = await prisma.user.findUnique({
        where: { telegramId: tgId },
      });
      if (user) return user;
    }
    throw error;
  }
}

// ==============================================
// COMANDOS
// ==============================================

async function startCommand(ctx: Context) {
  if (!ctx.from) {
    await ctx.reply('Não foi possível identificar seu usuário.');
    return;
  }

  try {
    const user = await getOrCreateUser(
      ctx.from.id,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );

    await ctx.reply(
      `👋 Olá ${ctx.from.first_name || 'usuário'}!\n\n` +
      `Bem-vindo ao bot de vendas.\n\n` +
      `Seu saldo: R$ ${user.balance.toFixed(2)}\n\n` +
      `Comandos disponíveis:\n` +
      `/produtos - Ver produtos disponíveis\n` +
      `/comprar <produtoId> <quantidade> - Comprar produto\n` +
      `/saldo - Consultar saldo\n` +
      `/giftcard <código> - Resgatar gift card\n` +
      `/afiliado - Ver/mostrar informações de afiliado\n` +
      `/saque <valor> <chavePix> - Solicitar saque\n` +
      `/meuspedidos - Ver seus últimos pedidos`
    );
  } catch (error) {
    logger.error({ error }, 'Erro no comando /start');
    await ctx.reply('Erro ao processar sua solicitação.');
  }
}

async function listProductsCommand(ctx: Context) {
  if (!ctx.from) return;

  try {
    const products = await prisma.product.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    });

    if (products.length === 0) {
      await ctx.reply('Nenhum produto disponível no momento.');
      return;
    }

    const list = products
      .map(
        (p) =>
          `ID: ${p.id} | ${p.name} | Preço: R$ ${p.price.toFixed(2)} | Estoque: ${p.stock}`
      )
      .join('\n');

    await ctx.reply(`📦 **Produtos disponíveis**\n\n${list}`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ error }, 'Erro ao listar produtos');
    await ctx.reply('Erro ao listar produtos.');
  }
}

async function buyCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 2) {
    await ctx.reply('Uso: /comprar <produtoId> <quantidade>');
    return;
  }

  const productId = parseInt(args[0]);
  const quantity = parseInt(args[1]);

  if (isNaN(productId) || isNaN(quantity) || quantity <= 0) {
    await ctx.reply('Valores inválidos. Informe ID de produto e quantidade positiva.');
    return;
  }

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);

    const blocked = await isUserBlocked(user.id, BlockType.PAYMENT_ATTEMPT);
    if (blocked) {
      await ctx.reply('Você está temporariamente bloqueado para realizar compras. Tente mais tarde.');
      return;
    }

    const { order, payment } = await createOrder({
      userId: user.id,
      items: [{ productId, quantity }],
    });

    let message = `🛒 **Pedido #${order.id}**\n`;
    message += `Total: R$ ${order.total.toFixed(2)}\n`;
    message += `Status: Aguardando pagamento\n\n`;

    if (payment.qrCodeBase64) {
      await ctx.replyWithPhoto(Buffer.from(payment.qrCodeBase64, 'base64'), {
        caption: message + `\nPague o PIX usando o QR Code acima ou copie o código abaixo:`,
      });
    } else if (payment.qrCode) {
      message += `Código PIX (copia e cola):\n\`${payment.qrCode}\``;
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } else {
      message += `Pagamento PIX pendente. Use o link externo para pagar.`;
      await ctx.reply(message);
    }
  } catch (error: any) {
    logger.error({ error, productId, quantity }, 'Erro ao criar pedido');
    if (error.message.includes('Estoque insuficiente')) {
      await ctx.reply('Estoque insuficiente para o produto solicitado.');
    } else if (error.message.includes('bloqueado')) {
      await ctx.reply('Você está temporariamente bloqueado para compras.');
    } else {
      await ctx.reply('Não foi possível concluir a compra. Tente novamente.');
    }
  }
}

async function balanceCommand(ctx: Context) {
  if (!ctx.from) return;

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
    await ctx.reply(`💰 Seu saldo atual: R$ ${user.balance.toFixed(2)}`);
  } catch (error) {
    logger.error({ error }, 'Erro ao consultar saldo');
    await ctx.reply('Erro ao consultar saldo.');
  }
}

async function redeemGiftCardCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 1) {
    await ctx.reply('Uso: /giftcard <código>');
    return;
  }

  const code = args[0].trim();

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);

    const blocked = await isUserBlocked(user.id);
    if (blocked) {
      await ctx.reply('Você está bloqueado e não pode resgatar gift cards.');
      return;
    }

    const redeemed = await redeemGiftCard({
      code,
      userId: user.id,
    });

    // Buscar saldo atualizado em variável antes de montar mensagem
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const currentBalance = updatedUser ? updatedUser.balance.toFixed(2) : '0.00';

    await ctx.reply(
      `🎉 Gift card resgatado com sucesso!\n` +
      `Valor adicionado: R$ ${redeemed.initialValue.toFixed(2)}\n` +
      `Saldo atual: R$ ${currentBalance}`
    );
  } catch (error: any) {
    logger.error({ error, code }, 'Erro ao resgatar gift card');
    if (error.message.includes('não encontrado')) {
      await ctx.reply('Gift card não encontrado.');
    } else if (error.message.includes('expirado')) {
      await ctx.reply('Este gift card está expirado.');
    } else if (error.message.includes('utilizado') || error.message.includes('ativo')) {
      await ctx.reply('Este gift card já foi utilizado ou não está mais ativo.');
    } else {
      await ctx.reply('Erro ao resgatar gift card.');
    }
  }
}

async function affiliateCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1);

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);

    if (args.length === 1 && (args[0].toLowerCase() === 'criar' || args[0].toLowerCase() === 'cadastrar')) {
      const existing = await getAffiliateByUserId(user.id);
      if (existing) {
        await ctx.reply(`Você já é afiliado! Seu código: ${existing.code}`);
        return;
      }
      const affiliate = await createAffiliate({ userId: user.id });
      await ctx.reply(
        `✅ Você agora é um afiliado!\n` +
        `Seu código: \`${affiliate.code}\`\n` +
        `Comissão: ${affiliate.commissionPercent.toFixed(2)}% sobre cada venda realizada por seu link.`
      );
      return;
    }

    const affiliate = await getAffiliateByUserId(user.id);
    if (affiliate) {
      await ctx.reply(
        `🔗 **Informações do Afiliado**\n` +
        `Código: \`${affiliate.code}\`\n` +
        `Comissão: ${affiliate.commissionPercent.toFixed(2)}%\n` +
        `Total ganho: R$ ${affiliate.totalEarned.toFixed(2)}\n` +
        `Saldo pendente: R$ ${affiliate.balance.toFixed(2)}`
      );
    } else {
      await ctx.reply(
        `Você ainda não é afiliado.\n` +
        `Para se cadastrar, envie: /afiliado criar`
      );
    }
  } catch (error) {
    logger.error({ error }, 'Erro no comando /afiliado');
    await ctx.reply('Erro ao processar comando de afiliado.');
  }
}

async function withdrawCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 2) {
    await ctx.reply('Uso: /saque <valor> <chavePix>');
    return;
  }

  const amount = parseFloat(args[0].replace(',', '.'));
  const pixKey = args[1].trim(); // chave Pix sem espaços

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Valor inválido. Use um número positivo.');
    return;
  }
  if (!pixKey) {
    await ctx.reply('Chave Pix inválida.');
    return;
  }

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);

    // Verifica bloqueio geral (qualquer tipo)
    const blocked = await isUserBlocked(user.id);
    if (blocked) {
      await ctx.reply('Você está bloqueado e não pode realizar saques.');
      return;
    }

    // Gera uma chave de idempotência única (UUID) para esta solicitação
    // Em caso de retry manual, o usuário deve reenviar a mesma chave (não implementado)
    const idempotencyKey = randomUUID();

    const withdrawal = await requestWithdrawal({
      userId: user.id,
      amount,
      pixKey,
      idempotencyKey,
    });

    await ctx.reply(
      `📤 Saque solicitado!\n` +
      `ID: ${withdrawal.id}\n` +
      `Valor: R$ ${withdrawal.amount.toFixed(2)}\n` +
      `Status: ${withdrawal.status}\n` +
      `Chave Pix: ${withdrawal.pixKey}\n\n` +
      `Acompanhe o status com /status_saque <id>`
    );
  } catch (error: any) {
    logger.error({ error }, 'Erro ao solicitar saque');
    if (error.message.includes('Saldo insuficiente')) {
      await ctx.reply('Saldo insuficiente para o saque.');
    } else if (error.message.includes('Chave Pix inválida')) {
      await ctx.reply(error.message);
    } else if (error.message.includes('bloqueado')) {
      await ctx.reply('Você está bloqueado para saques.');
    } else {
      await ctx.reply('Não foi possível solicitar o saque.');
    }
  }
}

async function myOrdersCommand(ctx: Context) {
  if (!ctx.from) return;

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);

    const orders = await prisma.order.findMany({
      where: { userId: user.id },
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });

    if (orders.length === 0) {
      await ctx.reply('Você ainda não tem pedidos.');
      return;
    }

    const text = orders
      .map((o) => {
        const itemsDesc = o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
        return `#${o.id} | ${o.createdAt.toLocaleString('pt-BR')} | Status: ${o.status} | Total: R$ ${o.total.toFixed(2)}\nItens: ${itemsDesc}`;
      })
      .join('\n\n');

    await ctx.reply(`📋 **Seus Últimos Pedidos**\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ error }, 'Erro ao listar pedidos');
    await ctx.reply('Erro ao listar pedidos.');
  }
}

async function withdrawalStatusCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 1) {
    await ctx.reply('Uso: /status_saque <id>');
    return;
  }

  const withdrawalId = parseInt(args[0]);
  if (isNaN(withdrawalId)) {
    await ctx.reply('ID inválido.');
    return;
  }

  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
    const withdrawal = await getWithdrawalById(withdrawalId);

    if (!withdrawal || withdrawal.userId !== user.id) {
      await ctx.reply('Saque não encontrado.');
      return;
    }

    await ctx.reply(
      `📤 **Saque #${withdrawal.id}**\n` +
      `Valor: R$ ${withdrawal.amount.toFixed(2)}\n` +
      `Status: ${withdrawal.status}\n` +
      `Chave Pix: ${withdrawal.pixKey}\n` +
      `Criado em: ${withdrawal.createdAt.toLocaleString('pt-BR')}\n` +
      (withdrawal.externalId ? `ID externo: ${withdrawal.externalId}\n` : '') +
      (withdrawal.failureReason ? `Falha: ${withdrawal.failureReason}\n` : '')
    );
  } catch (error) {
    logger.error({ error }, 'Erro ao consultar status de saque');
    await ctx.reply('Erro ao consultar status do saque.');
  }
}

// ==============================================
// REGISTRO DOS COMANDOS
// ==============================================

export function registerUserCommands(bot: Bot) {
  bot.command('start', startCommand);
  bot.command('produtos', listProductsCommand);
  bot.command('comprar', buyCommand);
  bot.command('saldo', balanceCommand);
  bot.command('giftcard', redeemGiftCardCommand);
  bot.command('afiliado', affiliateCommand);
  bot.command('saque', withdrawCommand);
  bot.command('meuspedidos', myOrdersCommand);
  bot.command('status_saque', withdrawalStatusCommand);

  logger.info('Comandos de usuário registrados.');
}
