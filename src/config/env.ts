import dotenv from 'dotenv';
import { z } from 'zod';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Schema de validação das variáveis de ambiente
const envSchema = z.object({
  // Bot
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  ADMIN_TELEGRAM_IDS: z.string().min(1, 'ADMIN_TELEGRAM_IDS é obrigatório'),

  // Ambiente
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Servidor Express (webhook)
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url('PUBLIC_URL deve ser uma URL válida'),
  WEBHOOK_SECRET: z
    .string()
    .min(32, 'WEBHOOK_SECRET deve ter no mínimo 32 caracteres'),

  // Banco de dados
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  // Mercado Pago
  MERCADO_PAGO_ACCESS_TOKEN: z
    .string()
    .min(1, 'MERCADO_PAGO_ACCESS_TOKEN é obrigatório'),
  MERCADO_PAGO_WEBHOOK_URL: z
    .string()
    .url('MERCADO_PAGO_WEBHOOK_URL deve ser uma URL válida'),
  MERCADO_PAGO_SANDBOX: z
    .string()
    .transform((val) => val.toLowerCase() === 'true')
    .default('false'),

  // Saques (payout)
  PAYOUT_PROVIDER: z
    .enum(['mercadopago'])
    .default('mercadopago'),
  PAYOUT_ACCESS_TOKEN: z.string().optional(),
});

// Tenta validar as variáveis de ambiente
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Erro na validação das variáveis de ambiente:');
  console.error(parsedEnv.error.flatten().fieldErrors);
  throw new Error('Variáveis de ambiente inválidas. Verifique o arquivo .env');
}

// Exporta o objeto tipado com as variáveis validadas
export const env = {
  bot: {
    token: parsedEnv.data.TELEGRAM_BOT_TOKEN,
    adminIds: parsedEnv.data.ADMIN_TELEGRAM_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number)
      .filter((id) => !Number.isNaN(id)),
  },
  nodeEnv: parsedEnv.data.NODE_ENV,
  logLevel: parsedEnv.data.LOG_LEVEL,
  server: {
    port: parsedEnv.data.PORT,
    publicUrl: parsedEnv.data.PUBLIC_URL,
    webhookSecret: parsedEnv.data.WEBHOOK_SECRET,
  },
  database: {
    url: parsedEnv.data.DATABASE_URL,
  },
  mercadoPago: {
    accessToken: parsedEnv.data.MERCADO_PAGO_ACCESS_TOKEN,
    webhookUrl: parsedEnv.data.MERCADO_PAGO_WEBHOOK_URL,
    sandbox: parsedEnv.data.MERCADO_PAGO_SANDBOX,
  },
  payout: {
    provider: parsedEnv.data.PAYOUT_PROVIDER,
    accessToken: parsedEnv.data.PAYOUT_ACCESS_TOKEN || parsedEnv.data.MERCADO_PAGO_ACCESS_TOKEN,
  },
} as const;

// Exibe aviso se estiver em produção com sandbox ativo
if (env.nodeEnv === 'production' && env.mercadoPago.sandbox) {
  console.warn(
    '⚠️ ATENÇÃO: Você está em produção com MERCADO_PAGO_SANDBOX=true. Isso pode resultar em pagamentos não reais.'
  );
}
