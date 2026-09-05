import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// Evita múltiplas instâncias do PrismaClient em desenvolvimento (hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Cria uma única instância reutilizável do PrismaClient
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

// Em desenvolvimento, armazena a instância globalmente para reutilização
if (env.nodeEnv !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Log de conexão bem-sucedida (apenas informativo, sem dados fictícios)
prisma
  .$connect()
  .then(() => {
    console.log('✅ Conectado ao PostgreSQL via Prisma.');
  })
  .catch((error) => {
    console.error('❌ Falha ao conectar ao banco de dados:', error);
    process.exit(1); // Encerra se não conectar, pois banco é fonte da verdade
  });
