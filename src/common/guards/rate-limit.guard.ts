import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { isCacheActive } from '../../infrastructure/cache/cache-helper';

export const RATE_LIMIT_KEY = 'kheleo:rate_limit';

export interface RateLimitRule {
  readonly keyPrefix: string;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly alwaysEnforce?: boolean;
}

export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_KEY, rule);

interface MemoryBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly fallbackBuckets = new Map<string, MemoryBucket>();

  constructor(
    @Optional() private readonly reflector?: Reflector,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const rule =
      this.reflector?.getAllAndOverride<RateLimitRule>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? Reflect.getMetadata(RATE_LIMIT_KEY, context.getHandler()) as RateLimitRule | undefined;
    if (!rule) return true;

    const enabled =
      rule.alwaysEnforce === true ||
      process.env.RATE_LIMIT_ENABLED === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.RATE_LIMIT_ENABLED !== 'false');
    if (!enabled) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      user?: { sub?: string };
    }>();
    const reply = http.getResponse<{
      header?: (name: string, value: string | number) => unknown;
    }>();

    const forwarded = request.headers?.['x-forwarded-for'];
    const clientIp =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0]!.trim()
        : (request.ip ?? 'unknown');
    const actorKey = request.user?.sub ? `u:${request.user.sub}` : `ip:${clientIp}`;
    const bucketKey = `ratelimit:v1:${rule.keyPrefix}:${actorKey}`;

    const result = await this.consume(bucketKey, rule.limit, rule.windowSeconds);
    if (typeof reply?.header === 'function') {
      reply.header('X-RateLimit-Limit', rule.limit);
      reply.header('X-RateLimit-Remaining', Math.max(0, rule.limit - result.count));
      if (!result.allowed) {
        reply.header('Retry-After', result.retryAfterSeconds);
      }
    }

    if (!result.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please retry later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ readonly allowed: boolean; readonly count: number; readonly retryAfterSeconds: number }> {
    const client = (this.redis as { client?: { eval?: (...args: unknown[]) => Promise<unknown> } } | undefined)
      ?.client;
    if (isCacheActive(this.redis) && typeof client?.eval === 'function') {
      try {
        const res = (await Promise.race([
          client.eval(
            `local current = redis.call('INCR', KEYS[1])
             if current == 1 then
               redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
             end
             local ttl = redis.call('TTL', KEYS[1])
             return {current, ttl}`,
            1,
            key,
            windowSeconds,
          ),
          new Promise<never>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Rate-limit Redis timeout')), 250);
            t.unref?.();
          }),
        ])) as [number, number];
        const count = Number(res[0] ?? 1);
        const ttl = Number(res[1] ?? windowSeconds);
        return {
          allowed: count <= limit,
          count,
          retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
        };
      } catch {
        // Fall through to bounded in-memory sliding counter cleanly
      }
    }

    const now = Date.now();
    if (this.fallbackBuckets.size > 10000) {
      this.fallbackBuckets.clear();
    }
    const existing = this.fallbackBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.fallbackBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, count: 1, retryAfterSeconds: windowSeconds };
    }
    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      allowed: existing.count <= limit,
      count: existing.count,
      retryAfterSeconds,
    };
  }
}

