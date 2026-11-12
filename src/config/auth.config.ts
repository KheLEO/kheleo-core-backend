import { registerAs } from '@nestjs/config';

export const authConfig = registerAs('auth', () => ({
  jwtPrivateKey: process.env.JWT_PRIVATE_KEY ?? '',
  jwtPublicKey: process.env.JWT_PUBLIC_KEY ?? '',
  jwtPrivateKeyPath: process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem',
  jwtPublicKeyPath: process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.pem',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY ?? '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  allowLegacyDrillSignatures:
    process.env.DRILL_ALLOW_LEGACY_SIGNATURES === 'true' ||
    (process.env.NODE_ENV !== 'production' &&
      process.env.DRILL_ALLOW_LEGACY_SIGNATURES !== 'false'),
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
  adminInviteCode: process.env.ADMIN_INVITE_CODE ?? '',
  identityPepper: process.env.IDENTITY_PEPPER ?? '',
  identitySaltVersion: parseInt(process.env.IDENTITY_SALT_VERSION ?? '1', 10),
  drillHmacSecret: process.env.DRILL_HMAC_SECRET ?? '',
  telemetryHmacSecret: process.env.TELEMETRY_SERVICE_HMAC_SECRET ?? '',
}));
