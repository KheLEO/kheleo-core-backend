import { registerAs } from '@nestjs/config';

export const authConfig = registerAs('auth', () => ({
  jwtPrivateKeyPath: process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem',
  jwtPublicKeyPath: process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.pem',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY ?? '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  identityPepper: process.env.IDENTITY_PEPPER ?? '',
  identitySaltVersion: parseInt(process.env.IDENTITY_SALT_VERSION ?? '1', 10),
  drillHmacSecret: process.env.DRILL_HMAC_SECRET ?? '',
  telemetryHmacSecret: process.env.TELEMETRY_SERVICE_HMAC_SECRET ?? '',
}));
