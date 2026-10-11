import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Observable, catchError, concatMap, from, of, throwError } from 'rxjs';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';

interface CachedIdempotentResponse {
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly body: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static readonly TTL_SECONDS = 86400;
  private static readonly LOCK_TTL_SECONDS = 300;
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
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

    const route = req.url.split('?')[0] ?? req.url;
    const requestBody = JSON.stringify(req.body ?? null);
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${req.method}:${route}:${requestBody}`)
      .digest('hex');
    const scopedKey = crypto
      .createHash('sha256')
      .update(`${req.method}:${route}:${idempotencyKey}`)
      .digest('hex');
    const redisKey = `idempotency:${scopedKey}`;
    const cachedResponse = await this.redis.get(redisKey);

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
    const acquired = await this.redis.setnx(
      lockKey,
      'ACQUIRED',
      IdempotencyInterceptor.LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      throw new ConflictException(
        'A request with this Idempotency-Key is currently being processed.',
      );
    }

    return next.handle().pipe(
      concatMap((responseBody: unknown) =>
        from(this.cacheResponse(redisKey, lockKey, fingerprint, res, responseBody)),
      ),
      catchError((error: unknown) =>
        from(this.redis.del(lockKey)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  private async cacheResponse(
    redisKey: string,
    lockKey: string,
    fingerprint: string,
    response: FastifyReply,
    body: unknown,
  ): Promise<unknown> {
    const payload: CachedIdempotentResponse = {
      fingerprint,
      statusCode: response.statusCode,
      body,
    };

    try {
      await this.redis.set(redisKey, JSON.stringify(payload), IdempotencyInterceptor.TTL_SECONDS);
      return body;
    } catch (error: unknown) {
      this.logger.error(`Failed to persist idempotent response for ${redisKey}: ${String(error)}`);
      return body;
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
