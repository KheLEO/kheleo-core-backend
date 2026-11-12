import { existsSync, readFileSync } from 'node:fs';
import { normalizePemSecret, validateRsaKeyPairPem } from '../modules/auth/jwt-keys';

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

  const rawPrivateKey = typeof env.JWT_PRIVATE_KEY === 'string' ? env.JWT_PRIVATE_KEY.trim() : '';
  const rawPublicKey = typeof env.JWT_PUBLIC_KEY === 'string' ? env.JWT_PUBLIC_KEY.trim() : '';
  if (Boolean(rawPrivateKey) !== Boolean(rawPublicKey)) {
    throw new Error('Both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be provided in production');
  }
  if (rawPrivateKey && rawPublicKey) {
    validateRsaKeyPairPem(normalizePemSecret(rawPrivateKey), normalizePemSecret(rawPublicKey));
  } else {
    const privatePath = required('JWT_PRIVATE_KEY_PATH');
    const publicPath = required('JWT_PUBLIC_KEY_PATH');
    if (!existsSync(privatePath)) {
      throw new Error('JWT_PRIVATE_KEY_PATH must identify a readable mounted key');
    }
    if (!existsSync(publicPath)) {
      throw new Error('JWT_PUBLIC_KEY_PATH must identify a readable mounted key');
    }
    validateRsaKeyPairPem(
      normalizePemSecret(readFileSync(privatePath, 'utf8')),
      normalizePemSecret(readFileSync(publicPath, 'utf8')),
    );
  }
  for (const name of ['SUPABASE_URL'])
    if (parseUrl(name, required(name)).protocol !== 'https:')
      throw new Error(`${name} must use HTTPS`);
  required('SUPABASE_PUBLISHABLE_KEY');
  const dbUrl = parseUrl('DATABASE_URL', required('DATABASE_URL'));
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL');
  if (dbUrl.port === '6543') {
    if (dbUrl.searchParams.get('pgbouncer') !== 'true') {
      throw new Error('DATABASE_URL on Supavisor port 6543 must include pgbouncer=true');
    }
    const directUrl = parseUrl('DIRECT_URL', required('DIRECT_URL'));
    if (!['postgres:', 'postgresql:'].includes(directUrl.protocol)) {
      throw new Error('DIRECT_URL must use PostgreSQL');
    }
  } else if (typeof env.DIRECT_URL === 'string' && env.DIRECT_URL.trim()) {
    const directUrl = parseUrl('DIRECT_URL', env.DIRECT_URL);
    if (!['postgres:', 'postgresql:'].includes(directUrl.protocol)) {
      throw new Error('DIRECT_URL must use PostgreSQL');
    }
  }
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
