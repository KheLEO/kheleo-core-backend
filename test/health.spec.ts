import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { IdempotencyInterceptor } from '../src/common/interceptors/idempotency.interceptor';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { HealthController } from '../src/modules/health/health.controller';
import { HealthResponse, HealthService } from '../src/modules/health/health.service';

interface HealthDependencies {
  readonly db: () => Promise<unknown>;
  readonly redis: () => Promise<string>;
}

@Module({})
class HealthTestModule {}

async function createApp(dependencies: HealthDependencies): Promise<NestFastifyApplication> {
  const redis = { client: { ping: dependencies.redis } };
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: HealthTestModule,
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: async (query: TemplateStringsArray): Promise<unknown> => {
              assert.deepEqual([...query], ['SELECT 1']);
              return dependencies.db();
            },
          },
        },
        { provide: RedisService, useValue: redis },
      ],
    },
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalInterceptors(
    new IdempotencyInterceptor(redis as unknown as RedisService),
    new ResponseTransformInterceptor(),
  );
  await app.init();
  return app;
}

describe('Public health and readiness HTTP endpoint', () => {
  it('returns the flat health contract without JWT or Idempotency-Key', async () => {
    const app = await createApp({ db: async () => [{ '?column?': 1 }], redis: async () => 'PONG' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      assert.equal(response.statusCode, 200);
      const body = response.json<HealthResponse>();
      assert.deepEqual(Object.keys(body).sort(), ['db', 'redis', 'status', 'uptime']);
      assert.equal(body.status, 'ok');
      assert.equal(body.db, 'ok');
      assert.equal(body.redis, 'ok');
      assert.equal(typeof body.uptime, 'number');
      assert.ok(body.uptime >= 0);
    } finally {
      await app.close();
    }
  });

  for (const failedDependency of ['db', 'redis', 'both'] as const) {
    it(`reports ${failedDependency} outages as HTTP 503 without leaking errors`, async () => {
      const fail = async (): Promise<never> => {
        throw new Error('private-connection-details');
      };
      const app = await createApp({
        db: failedDependency === 'redis' ? async () => [] : fail,
        redis: failedDependency === 'db' ? async () => 'PONG' : fail,
      });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(response.statusCode, 503);
        const body = response.json<HealthResponse>();
        assert.equal(body.status, 'degraded');
        assert.equal(body.db, failedDependency === 'redis' ? 'ok' : 'unavailable');
        assert.equal(body.redis, failedDependency === 'db' ? 'ok' : 'unavailable');
        assert.equal(response.body.includes('private-connection-details'), false);
      } finally {
        await app.close();
      }
    });
  }

  it('treats an unexpected Redis ping reply as degraded', async () => {
    const app = await createApp({ db: async () => [], redis: async () => 'NOT_PONG' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json<HealthResponse>().redis, 'unavailable');
    } finally {
      await app.close();
    }
  });

  it('bounds unresponsive dependency checks', { timeout: 5000 }, async () => {
    const app = await createApp({
      db: () => new Promise<never>(() => undefined),
      redis: () => new Promise<never>(() => undefined),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      assert.equal(response.statusCode, 503);
      const body = response.json<HealthResponse>();
      assert.equal(body.db, 'unavailable');
      assert.equal(body.redis, 'unavailable');
    } finally {
      await app.close();
    }
  });
});
