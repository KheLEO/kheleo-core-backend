import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL ?? '',
  directUrl: process.env.DIRECT_URL ?? '',
}));
