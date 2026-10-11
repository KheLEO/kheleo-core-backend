import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static readonly TTL_SECONDS = 86400;

  constructor(private readonly redis: RedisService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const res = http.getResponse<FastifyReply>();

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (req.method === 'GET' || req.method === 'HEAD' || !idempotencyKey) {
      return next.handle();
    }

    if (idempotencyKey.length < 16) {
      throw new BadRequestException(
        'Idempotency-Key must be at least 16 characters long.',
      );
    }

    const redisKey = `idempotency:${idempotencyKey}`;
    const cachedResponse = await this.redis.get(redisKey);

    if (cachedResponse) {
      const parsed = JSON.parse(cachedResponse) as {
        statusCode: number;
        body: unknown;
      };
      void res.header('X-Cache-Lookup', 'IDEMPOTENT_HIT');
      void res.status(parsed.statusCode);
      return of(parsed.body);
    }

    const lockKey = `lock:${redisKey}`;
    const acquired = await this.redis.setnx(lockKey, 'ACQUIRED', 30);
    if (!acquired) {
      throw new ConflictException(
        'A request with this Idempotency-Key is currently being processed.',
      );
    }

    return next.handle().pipe(
      tap({
        next: async (responseBody: unknown) => {
          const payload = {
            statusCode: res.statusCode ?? 200,
            body: responseBody,
          };
          await this.redis.set(
            redisKey,
            JSON.stringify(payload),
            IdempotencyInterceptor.TTL_SECONDS,
          );
          await this.redis.del(lockKey);
        },
        error: async () => {
          await this.redis.del(lockKey);
        },
      }),
    );
  }
}
