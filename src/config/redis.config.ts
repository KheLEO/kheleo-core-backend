import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL || undefined,
  username: process.env.REDIS_USERNAME || undefined,
  tls: process.env.REDIS_TLS === 'true',
  db: Number(process.env.REDIS_DB ?? 0),
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
}));
