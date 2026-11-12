import { Injectable, OnModuleInit, OnApplicationShutdown, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    const logQueries = process.env.PRISMA_LOG_QUERIES === 'true';
    super({
      log: [
        ...(logQueries ? ([{ emit: 'stdout', level: 'query' }] as const) : []),
        ...(!isProduction ? ([{ emit: 'stdout', level: 'info' }] as const) : []),
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL connected via Prisma');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    this.logger.log('PostgreSQL disconnected');
  }
}
