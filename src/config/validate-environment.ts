import { existsSync } from 'node:fs';
export function validateEnvironment(env: Record<string, unknown>): Record<string, unknown> {
  if (env.NODE_ENV !== 'production') return env;
  const required = (name: string): string => {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${name} is required in production`);
    return value;
  };
  const parseUrl = (name: string, value: string): URL => {
    try {
      return new URL(value);
    } catch {
      throw new Error(`${name} must be a valid URL`);
    }
  };
  for (const name of ['IDENTITY_PEPPER', 'DRILL_HMAC_SECRET', 'TELEMETRY_SERVICE_HMAC_SECRET'])
    if (!/^[a-f0-9]{64,}$/i.test(required(name)))
      throw new Error(`${name} must contain at least 32 random bytes encoded as hex`);
  for (const name of ['JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH'])
    if (!existsSync(required(name)))
      throw new Error(`${name} must identify a readable mounted key`);
  for (const name of ['SUPABASE_URL'])
    if (parseUrl(name, required(name)).protocol !== 'https:')
      throw new Error(`${name} must use HTTPS`);
  required('SUPABASE_PUBLISHABLE_KEY');
  if (
    !['postgres:', 'postgresql:'].includes(
      parseUrl('DATABASE_URL', required('DATABASE_URL')).protocol,
    )
  )
    throw new Error('DATABASE_URL must use PostgreSQL');
  for (const origin of required('CORS_ORIGINS')
    .split(',')
    .map((item) => item.trim())) {
    const url = parseUrl('CORS_ORIGINS', origin);
    if (url.protocol !== 'https:' || url.origin !== origin)
      throw new Error('CORS_ORIGINS must contain exact HTTPS origins');
  }
  for (const [name, fallback, min, max] of [
    ['PORT', 3000, 1, 65535],
    ['REDIS_PORT', 6379, 1, 65535],
    ['REDIS_DB', 0, 0, 15],
    ['IDENTITY_SALT_VERSION', 1, 1, 1000],
  ] as const) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} is outside its valid range`);
  }
  if (env.REDIS_URL) {
    const url = parseUrl('REDIS_URL', String(env.REDIS_URL));
    if (!['redis:', 'rediss:'].includes(url.protocol))
      throw new Error('REDIS_URL must use Redis TCP');
  } else required('REDIS_HOST');
  return env;
}
