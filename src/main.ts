import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import compression from '@fastify/compress';
import { AppModule } from './app.module';
import { Rfc7807ExceptionFilter } from './common/filters/rfc7807-exception.filter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { RedisIoAdapter } from './infrastructure/realtime/redis-io.adapter';
import { RedisService } from './infrastructure/cache/redis.service';
import { ConfigService } from '@nestjs/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // ─── Compression ────────────────────────────────────
  await app.register(compression as unknown as Parameters<NestFastifyApplication['register']>[0], {
    encodings: ['gzip', 'br'],
  });

  // ─── CORS ───────────────────────────────────────────
  const configService = app.get(ConfigService);
  const corsOrigins = configService.get<readonly string[]>('app.corsOrigins', [
    'http://localhost:3000',
  ]);
  app.enableCors({
    origin: [...corsOrigins],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Drill-Signature',
      'X-Drill-Signed-Fields',
      'X-Device-Signature',
      'X-Timestamp',
      'If-None-Match',
    ],
    exposedHeaders: ['ETag', 'X-Cache-Lookup', 'X-Request-Id', 'X-Next-Cursor'],
  });

  // ─── Versioning ─────────────────────────────────────
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // ─── Pipes ──────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ─── Filters ────────────────────────────────────────
  app.useGlobalFilters(new Rfc7807ExceptionFilter(), new PrismaExceptionFilter());

  // ─── Interceptors ───────────────────────────────────
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseTransformInterceptor());

  // ─── WebSocket Adapter ──────────────────────────────
  const redisIoAdapter = new RedisIoAdapter(app, app.get(RedisService), corsOrigins);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.enableShutdownHooks();

  // ─── Swagger ────────────────────────────────────────
  const nodeEnv = configService.get<string>('app.nodeEnv', 'development');
  const isCi = process.env.CI === 'true' || Boolean(process.env.GITHUB_ACTIONS);
  if (nodeEnv !== 'production' || isCi || process.env.ENABLE_SWAGGER === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Kheleo Core Backend')
      .setDescription(
        'Edge-AI & IoT Sports Platform API — Talent Discovery, Anti-Sandbagging, Dynamic Matchmaking, and Player Safety',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'idempotency-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  // ─── Start ──────────────────────────────────────────
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
