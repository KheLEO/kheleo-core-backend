import { ConfigService } from '@nestjs/config';
import { RedisOptions } from 'ioredis';
export function redisOptions(config: ConfigService, worker = false): RedisOptions {
  const raw = config.get<string>('redis.url');
  const url = raw ? new URL(raw) : undefined;
  if (url && !['redis:', 'rediss:'].includes(url.protocol))
    throw new Error('REDIS_URL must use redis:// or rediss://');
  const tls = url?.protocol === 'rediss:' || config.get<boolean>('redis.tls', false);
  return {
    host: url?.hostname ?? config.get<string>('redis.host', 'localhost'),
    port: url?.port ? Number(url.port) : config.get<number>('redis.port', 6379),
    username: url?.username
      ? decodeURIComponent(url.username)
      : config.get<string>('redis.username') || undefined,
    password: url?.password
      ? decodeURIComponent(url.password)
      : config.get<string>('redis.password') || undefined,
    db:
      url?.pathname && url.pathname !== '/'
        ? Number(url.pathname.slice(1))
        : config.get<number>('redis.db', 0),
    ...(tls ? { tls: { rejectUnauthorized: true } } : {}),
    connectTimeout: 5000,
    ...(worker
      ? { maxRetriesPerRequest: null }
      : { maxRetriesPerRequest: 1, commandTimeout: 5000, enableOfflineQueue: false }),
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  };
}
