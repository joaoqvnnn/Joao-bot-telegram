import { Bot, GrammyError, HttpError } from 'grammy';
import express from 'express';
import { env } from './config/env';
import logger from './lib/logger';
import { prisma } from './lib/prisma';

// ==============================================
// INICIALIZAÇÃO DO BOT (Telegram)
// ==============================================

const bot = new Bot(env.bot.token);

// Middleware de log de comandos
bot.use(async (ctx, next) => {
  const update = ctx.update;
  logger.debug({ update }, 'Update recebido do Telegram');
  await next();
});

// Tratamento de erros do bot
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;

  if (e instanceof GrammyError) {
    logger.error({ error: e.description, code: e.error_code }, 'Erro na API do Telegram');
  } else if (e instanceof HttpError) {
    logger.error({ error: e }, 'Erro de HTTP no bot');
  } else {
    logger.error({ error: e }, 'Erro desconhecido no bot');
  }

  // Notifica o usuário sobre erro interno (sem dados fictícios)
  if (ctx) {
    ctx.reply('Ocorreu um erro interno. Tente novamente mais tarde.').catch(() => {});
  }
});

// Comando básico de verificação de funcionamento (real, sem simulação)
bot.command('ping', async (ctx) => {
  const startTime = Date.now();
  await ctx.reply('pong');
  const responseTime = Date.now() - startTime;
  logger.info({ responseTime, userId: ctx.from?.id }, 'Comando /ping executado');
});

// Inicia o bot em modo polling (long polling)
// Em produção, pode-se trocar para webhook configurando o domínio.
bot.start({
  onStart: (botInfo) => {
    logger.info(`Bot @${botInfo.username} iniciado com sucesso`);
  },
});

logger.info('Bot do Telegram iniciado em modo polling.');

// ==============================================
// SERVIDOR EXPRESS (Webhooks)
// ==============================================

const app = express();
app.use(express.json());

// Rota de webhook do Mercado Pago
app.post('/webhooks/mercadopago', async (req, res) => {
  const payload = req.body;
  const eventId = payload?.id || payload?.data?.id;

  if (!eventId) {
    logger.warn('Webhook recebido sem ID de evento');
    return res.status(400).json({ error: 'ID de evento ausente' });
  }

  try {
    // Idempotência: verifica se já existe evento com este ID
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventId: String(eventId) },
    });

    if (existingEvent) {
      logger.info({ eventId }, 'Evento de webhook já processado, ignorando duplicata');
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Persiste o evento recebido (fonte da verdade: banco de dados)
    const savedEvent = await prisma.webhookEvent.create({
      data: {
        provider: 'mercadopago',
        eventId: String(eventId),
        type: payload?.type || 'unknown',
        payload: payload,
        status: 'RECEIVED',
      },
    });

    logger.info({ eventId, type: savedEvent.type }, 'Webhook do Mercado Pago persistido');
    return res.status(200).json({ received: true, eventId: savedEvent.id });
  } catch (error) {
    logger.error({ error, eventId }, 'Erro ao processar webhook do Mercado Pago');
    return res.status(500).json({ error: 'Erro interno ao processar webhook' });
  }
});

// Rota de saúde (verificação simples)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inicia o servidor Express
const server = app.listen(env.server.port, () => {
  logger.info(`Servidor Express rodando na porta ${env.server.port}`);
});

// ==============================================
// ENCERRAMENTO GRACIOSO (graceful shutdown)
// ==============================================

async function shutdown(signal: string) {
  logger.info(`Recebido ${signal}, encerrando...`);
  try {
    // Para o bot
    await bot.stop();
    logger.info('Bot parado.');

    // Fecha o servidor HTTP
    server.close(() => {
      logger.info('Servidor HTTP fechado.');
    });

    // Desconecta do Prisma
    await prisma.$disconnect();
    logger.info('Conexão com banco de dados encerrada.');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Erro durante encerramento');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
