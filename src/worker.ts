import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Bootstraps the dedicated headless worker process for Railway deployments
 * where API replicas run with ENABLE_EMBEDDED_WORKERS=false.
 */
async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}; shutting down KheLEO background workers gracefully`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error(
        `Worker shutdown error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.log('KheLEO background worker runtime active (OutboxDispatcher + BullMQ processors)');
}

bootstrapWorker().catch((error) => {
  console.error('Worker bootstrap failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

