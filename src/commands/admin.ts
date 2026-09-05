import { Bot, Context } from 'grammy';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { env } from '../config/env';
import { createGiftCard } from '../services/giftcard.service';
import { createBlock, removeBlock, expireOldBlocks } from '../services/block.service';
import { BlockType, Prisma } from '@prisma/client';

// ==============================================
// TIPOS AUXILIARES
// ==============================================

interface AdminCommandContext extends Context {
  // Pode ser estendido se necessário
}

// ==============================================
// VERIFICAÇÃO DE ADMIN
// ==============================================

/**
 * Middleware para permitir apenas administradores.
 */
async function isAdmin(ctx: AdminCommandContext, next: () => Promise<void>) {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    await ctx.reply('Não foi possível identificar seu usuário.');
    return;
  }

  if (!env.bot.adminIds.includes(telegramId)) {
    await ctx.reply('Acesso negado. Este comando é restrito a administradores.');
    return;
  }

  await next();
}

// ==============================================
// COMANDOS ADMINISTRATIVOS
// ==============================================

/**
 * Painel de ajuda administrativa.
 */
async function adminHelp(ctx: AdminCommandContext) {
  const helpText = `
🛠 **Painel Administrativo**

Comandos disponíveis:
/ler - Listar produtos
/addproduct <preço> <estoque> <nome> [descrição] - Adicionar produto
  (ex: /addproduct 29.90 10 Camiseta Preta)
/editproduct <id> <campo> <valor> - Editar produto (nome, preco, estoque, ativo)
/stock <produtoId> <quantidade> - Ajustar estoque (use número positivo/negativo)
/giftcard <valor> [dias_expiração] - Criar gift card
/block <telegramId> <minutos> <motivo> - Bloquear usuário temporariamente
/unblock <blockId> - Remover bloqueio manualmente
/expireblocks - Expirar bloqueios vencidos manualmente
/pedidos - Ver últimos 10 pedidos
  `;
  await ctx.reply(helpText, { parse_mode: 'Markdown' });
}

/**
 * Lista produtos ativos.
 */
async function listProducts(ctx: AdminCommandContext) {
  try {
    const products = await prisma.product.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    });

    if (products.length === 0) {
      await ctx.reply('Nenhum produto ativo encontrado.');
      return;
    }

    const productList = products
      .map(
        (p) =>
          `ID: ${p.id} | ${p.name} | Preço: R$ ${p.price.toFixed(2)} | Estoque: ${p.stock}`
      )
      .join('\n');

    await ctx.reply(`📦 **Produtos Ativos**\n\n${productList}`, {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    logger.error({ error }, 'Erro ao listar produtos');
    await ctx.reply('Erro ao listar produtos. Verifique os logs.');
  }
}

/**
 * Adiciona um novo produto.
 * Formato: /addproduct <preço> <estoque> <nome> [descrição]
 */
async function addProduct(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 3) {
    await ctx.reply('Uso: /addproduct <preço> <estoque> <nome> [descrição]');
    return;
  }

  const price = parseFloat(args[0].replace(',', '.'));
  const stock = parseInt(args[1]);
  // O nome é o terceiro argumento até o final (sem descrição)
  const name = args.slice(2).join(' ');
  const description = null; // descrição opcional será ignorada por enquanto

  if (isNaN(price) || price <= 0) {
    await ctx.reply('Preço inválido. Use um número positivo (ex: 29.90).');
    return;
  }
  if (isNaN(stock) || stock < 0) {
    await ctx.reply('Estoque inválido. Use um inteiro não negativo.');
    return;
  }
  if (!name) {
    await ctx.reply('Nome do produto não pode ser vazio.');
    return;
  }

  try {
    const product = await prisma.product.create({
      data: {
        name,
        description,
        price: new Prisma.Decimal(price.toFixed(2)),
        stock,
        active: true,
      },
    });

    logger.info({ productId: product.id, name, price, stock }, 'Produto criado via comando admin.');
    await ctx.reply(`✅ Produto criado: ID ${product.id} - ${product.name} - R$ ${product.price.toFixed(2)} - Estoque: ${product.stock}`);
  } catch (error) {
    logger.error({ error }, 'Erro ao criar produto');
    await ctx.reply('Erro ao criar produto. Verifique os logs.');
  }
}

/**
 * Edita um produto.
 * Formato: /editproduct <id> <campo> <valor>
 * Campos: nome, preco, estoque, ativo (true/false)
 */
async function editProduct(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 3) {
    await ctx.reply('Uso: /editproduct <id> <campo> <valor>\nCampos: nome, preco, estoque, ativo');
    return;
  }

  const productId = parseInt(args[0]);
  const field = args[1].toLowerCase();
  // O valor é tudo que vem depois do campo, permitindo espaços
  const value = args.slice(2).join(' ');

  if (isNaN(productId)) {
    await ctx.reply('ID de produto inválido.');
    return;
  }

  try {
    let data: any = {};

    switch (field) {
      case 'nome':
        data.name = value;
        break;
      case 'preco':
        const price = parseFloat(value.replace(',', '.'));
        if (isNaN(price) || price <= 0) {
          await ctx.reply('Preço inválido.');
          return;
        }
        data.price = new Prisma.Decimal(price.toFixed(2));
        break;
      case 'estoque':
        const stock = parseInt(value);
        if (isNaN(stock) || stock < 0) {
          await ctx.reply('Estoque inválido.');
          return;
        }
        data.stock = stock;
        break;
      case 'ativo':
        data.active = value.toLowerCase() === 'true';
        break;
      default:
        await ctx.reply('Campo desconhecido. Use: nome, preco, estoque, ativo');
        return;
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data,
    });

    logger.info({ productId, field, value }, 'Produto editado via comando admin.');
    await ctx.reply(`✅ Produto ID ${product.id} atualizado: ${field} = ${value}`);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      await ctx.reply('Produto não encontrado.');
    } else {
      logger.error({ error }, 'Erro ao editar produto');
      await ctx.reply('Erro ao editar produto.');
    }
  }
}

/**
 * Ajusta estoque de um produto de forma atômica.
 * Formato: /stock <produtoId> <quantidade>
 * - Quantidade positiva: adiciona estoque.
 * - Quantidade negativa: remove estoque (com verificação atômica de saldo suficiente).
 */
async function adjustStock(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 2) {
    await ctx.reply('Uso: /stock <produtoId> <quantidade> (ex: /stock 2 10 ou /stock 2 -5)');
    return;
  }

  const productId = parseInt(args[0]);
  const quantity = parseInt(args[1]);

  if (isNaN(productId) || isNaN(quantity) || quantity === 0) {
    await ctx.reply('Valores inválidos. Forneça ID e quantidade não nula.');
    return;
  }

  try {
    if (quantity > 0) {
      // Adiciona estoque com incremento atômico
      await prisma.product.update({
        where: { id: productId },
        data: { stock: { increment: quantity } },
      });
      logger.info({ productId, quantity }, 'Estoque incrementado via comando admin.');
    } else {
      // Remove estoque com decremento condicional (evita estoque negativo)
      const result = await prisma.product.updateMany({
        where: {
          id: productId,
          stock: { gte: Math.abs(quantity) },
        },
        data: { stock: { decrement: Math.abs(quantity) } },
      });

      if (result.count === 0) {
        await ctx.reply('Estoque insuficiente para a remoção solicitada.');
        return;
      }
      logger.info({ productId, quantity }, 'Estoque decrementado via comando admin.');
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (product) {
      await ctx.reply(`✅ Estoque do produto ID ${productId} agora é ${product.stock}.`);
    } else {
      await ctx.reply('Produto não encontrado.');
    }
  } catch (error) {
    logger.error({ error }, 'Erro ao ajustar estoque');
    await ctx.reply('Erro ao ajustar estoque.');
  }
}

/**
 * Cria um gift card.
 * Formato: /giftcard <valor> [dias_expiração]
 */
async function createGiftCardCommand(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 1) {
    await ctx.reply('Uso: /giftcard <valor> [dias_expiração]');
    return;
  }

  const value = parseFloat(args[0].replace(',', '.'));
  if (isNaN(value) || value <= 0) {
    await ctx.reply('Valor inválido.');
    return;
  }

  let expiresAt: Date | undefined;
  if (args.length >= 2) {
    const days = parseInt(args[1]);
    if (isNaN(days) || days <= 0) {
      await ctx.reply('Número de dias inválido.');
      return;
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  try {
    // Busca o usuário interno pelo Telegram ID para usar o ID correto
    const telegramId = ctx.from?.id;
    let userId: number | undefined = undefined;
    if (telegramId) {
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
      });
      if (user) userId = user.id;
    }

    const giftCard = await createGiftCard({
      initialValue: value,
      expiresAt,
      createdByUserId: userId,
    });

    await ctx.reply(
      `🎁 Gift Card criado:\nCódigo: \`${giftCard.code}\`\nValor: R$ ${giftCard.initialValue.toFixed(2)}\nExpira: ${giftCard.expiresAt ? giftCard.expiresAt.toISOString() : 'nunca'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error({ error }, 'Erro ao criar gift card');
    await ctx.reply('Erro ao criar gift card.');
  }
}

/**
 * Bloqueia um usuário pelo Telegram ID.
 * Formato: /block <telegramId> <minutos> <motivo>
 */
async function blockUserCommand(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 3) {
    await ctx.reply('Uso: /block <telegramId> <minutos> <motivo>');
    return;
  }

  const telegramId = parseInt(args[0]);
  const minutes = parseInt(args[1]);
  const reason = args.slice(2).join(' ');

  if (isNaN(telegramId) || isNaN(minutes) || minutes <= 0 || !reason) {
    await ctx.reply('Parâmetros inválidos. Forneça ID, minutos positivos e motivo.');
    return;
  }

  try {
    // Busca o usuário interno pelo Telegram ID
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });

    if (!user) {
      await ctx.reply('Usuário não encontrado no banco de dados.');
      return;
    }

    const block = await createBlock({
      userId: user.id,
      type: BlockType.ADMIN_MANUAL, // usa o enum correto
      durationMinutes: minutes,
      reason,
    });

    await ctx.reply(
      `✅ Usuário bloqueado por ${minutes} minutos.\nBlock ID: ${block.id}\nMotivo: ${reason}`
    );
  } catch (error) {
    logger.error({ error }, 'Erro ao bloquear usuário');
    await ctx.reply('Erro ao bloquear usuário.');
  }
}

/**
 * Remove um bloqueio ativo.
 * Formato: /unblock <blockId>
 */
async function unblockCommand(ctx: AdminCommandContext) {
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length < 1) {
    await ctx.reply('Uso: /unblock <blockId>');
    return;
  }

  const blockId = parseInt(args[0]);
  if (isNaN(blockId)) {
    await ctx.reply('Block ID inválido.');
    return;
  }

  try {
    await removeBlock(blockId);
    await ctx.reply(`✅ Bloqueio ID ${blockId} removido.`);
  } catch (error) {
    logger.error({ error }, 'Erro ao remover bloqueio');
    await ctx.reply('Erro ao remover bloqueio.');
  }
}

/**
 * Expira bloqueios vencidos manualmente.
 */
async function expireBlocksCommand(ctx: AdminCommandContext) {
  try {
    const count = await expireOldBlocks();
    await ctx.reply(`✅ ${count} bloqueio(s) expirado(s).`);
  } catch (error) {
    logger.error({ error }, 'Erro ao expirar bloqueios');
    await ctx.reply('Erro ao expirar bloqueios.');
  }
}

/**
 * Mostra os últimos 10 pedidos (independente de status).
 */
async function listOrdersCommand(ctx: AdminCommandContext) {
  try {
    const orders = await prisma.order.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { telegramId: true, username: true } },
        items: true,
      },
    });

    if (orders.length === 0) {
      await ctx.reply('Nenhum pedido encontrado.');
      return;
    }

    const text = orders
      .map((o) => {
        const itemsDesc = o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
        return `Pedido #${o.id} | ${o.createdAt.toLocaleString('pt-BR')} | Status: ${o.status} | Total: R$ ${o.total.toFixed(2)} | Cliente: ${o.user.username || o.user.telegramId}\nItens: ${itemsDesc}`;
      })
      .join('\n\n');

    await ctx.reply(`📋 **Últimos Pedidos**\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ error }, 'Erro ao listar pedidos');
    await ctx.reply('Erro ao listar pedidos.');
  }
}

// ==============================================
// REGISTRO DOS COMANDOS
// ==============================================

/**
 * Registra todos os comandos administrativos no bot.
 * Cada comando é protegido individualmente com o middleware isAdmin.
 */
export function registerAdminCommands(bot: Bot) {
  bot.command('admin', isAdmin, adminHelp);
  bot.command('ler', isAdmin, listProducts);
  bot.command('addproduct', isAdmin, addProduct);
  bot.command('editproduct', isAdmin, editProduct);
  bot.command('stock', isAdmin, adjustStock);
  bot.command('giftcard', isAdmin, createGiftCardCommand);
  bot.command('block', isAdmin, blockUserCommand);
  bot.command('unblock', isAdmin, unblockCommand);
  bot.command('expireblocks', isAdmin, expireBlocksCommand);
  bot.command('pedidos', isAdmin, listOrdersCommand);

  logger.info('Comandos administrativos registrados.');
}
