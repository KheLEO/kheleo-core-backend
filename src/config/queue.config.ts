import { registerAs } from '@nestjs/config';

export const queueConfig = registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
}));
