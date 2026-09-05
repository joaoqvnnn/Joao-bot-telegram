import pino from 'pino';
import { env } from '../config/env';

// Configuração do logger Pino
// Em desenvolvimento, usa pino-pretty para logs legíveis.
// Em produção, usa JSON estruturado para melhor análise.

const loggerOptions: pino.LoggerOptions = {
  level: env.logLevel,
  base: {
    service: 'telegram-commerce-bot',
    env: env.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Adiciona pretty print apenas em desenvolvimento
const logger = pino(
  loggerOptions,
  env.nodeEnv === 'development'
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined
);

export default logger;
