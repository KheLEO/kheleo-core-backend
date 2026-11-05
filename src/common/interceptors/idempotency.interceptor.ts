import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Observable, catchError, concatMap, defer, from, of, throwError } from 'rxjs';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';
import { Reflector } from '@nestjs/core';

export const FRESH_IDEMPOTENCY_KEY = 'idempotency:require-fresh-execution';

interface IdempotentRequest extends FastifyRequest {
  readonly user?: { readonly sub: string };
}

interface CachedIdempotentResponse {
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly body: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new BadRequestException('Request body must contain valid JSON values.');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key: string) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static readonly TTL_SECONDS = 86400;
  private static readonly LOCK_TTL_SECONDS = 300;
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<IdempotentRequest>();
    const res = http.getResponse<FastifyReply>();

    const idempotencyHeader = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(idempotencyHeader)
      ? idempotencyHeader[0]
      : idempotencyHeader;

    if (req.method === 'GET' || req.method === 'HEAD') {
      return next.handle();
    }

    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    if (idempotencyKey.length < 16) {
      throw new BadRequestException('Idempotency-Key must be at least 16 characters long.');
    }

    const deviceHeader = req.headers['x-device-signature'];
    const deviceSignature = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
    const actorScope = req.user?.sub ?? deviceSignature ?? req.ip ?? 'anonymous';
    const fingerprint = crypto
      .createHash('sha256')
      .update(
        canonicalJson({ actorScope, method: req.method, url: req.url, body: req.body ?? null }),
      )
      .digest('hex');
    const redisKey = `idempotency:${actorScope}:${req.method}:${req.url}:${idempotencyKey}`;
    const freshExecution =
      this.reflector.get<boolean>(FRESH_IDEMPOTENCY_KEY, context.getHandler()) === true;
    const cachedResponse = freshExecution ? null : await this.redis.get(redisKey);

    if (cachedResponse) {
      try {
        const parsed = JSON.parse(cachedResponse) as CachedIdempotentResponse;
        if (parsed.fingerprint !== fingerprint) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different request payload.',
          );
        }
        void res.header('X-Cache-Lookup', 'IDEMPOTENT_HIT');
        void res.status(parsed.statusCode);
        return of(parsed.body);
      } catch (error: unknown) {
        if (error instanceof ConflictException) {
          throw error;
        }
        await this.redis.del(redisKey);
      }
    }

    const lockKey = `lock:${redisKey}`;
    const lockOwnerToken = crypto.randomUUID();
    const acquired = await this.redis.setnx(
      lockKey,
      lockOwnerToken,
      IdempotencyInterceptor.LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      throw new ConflictException(
        'A request with this Idempotency-Key is currently being processed.',
      );
    }

    return defer(() => next.handle()).pipe(
      concatMap((responseBody: unknown) =>
        from(
          this.cacheResponse(
            redisKey,
            lockKey,
            lockOwnerToken,
            fingerprint,
            res,
            responseBody,
            !freshExecution,
          ),
        ),
      ),
      catchError((error: unknown) =>
        from(this.releaseLock(lockKey, lockOwnerToken)).pipe(
          concatMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private async cacheResponse(
    redisKey: string,
    lockKey: string,
    lockOwnerToken: string,
    fingerprint: string,
    response: FastifyReply,
    body: unknown,
    persist: boolean,
  ): Promise<unknown> {
    const payload: CachedIdempotentResponse = {
      fingerprint,
      statusCode: response.statusCode,
      body,
    };

    try {
      if (persist)
        await this.redis.set(redisKey, JSON.stringify(payload), IdempotencyInterceptor.TTL_SECONDS);
      return body;
    } catch (error: unknown) {
      this.logger.error(`Failed to persist idempotent response for ${redisKey}: ${String(error)}`);
      return body;
    } finally {
      await this.releaseLock(lockKey, lockOwnerToken);
    }
  }

  private async releaseLock(lockKey: string, lockOwnerToken: string): Promise<void> {
    try {
      await this.redis.deleteIfValueMatches(lockKey, lockOwnerToken);
    } catch (error: unknown) {
      this.logger.error(`Failed to release idempotency lock: ${String(error)}`);
    }
  }
}
