import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';

interface LocalJwtKeys {
  readonly signingKey: string;
  readonly verificationKey: string;
  readonly algorithm: 'RS256' | 'HS256';
}

export function loadLocalJwtKeys(config: ConfigService): LocalJwtKeys {
  const privatePath = config.get<string>('auth.jwtPrivateKeyPath', './keys/private.pem');
  const publicPath = config.get<string>('auth.jwtPublicKeyPath', './keys/public.pem');
  const hasPrivate = existsSync(privatePath);
  const hasPublic = existsSync(publicPath);
  if (hasPrivate !== hasPublic) {
    throw new Error('Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must exist.');
  }
  if (hasPrivate) {
    return {
      signingKey: readFileSync(privatePath, 'utf8'),
      verificationKey: readFileSync(publicPath, 'utf8'),
      algorithm: 'RS256',
    };
  }
  const secret = config.get<string>('auth.identityPepper');
  if (!secret && config.get<string>('app.nodeEnv', 'development') === 'production') {
    throw new Error('JWT key pair or IDENTITY_PEPPER must be configured in production.');
  }
  const signingKey = secret || 'local-development-jwt-secret';
  return { signingKey, verificationKey: signingKey, algorithm: 'HS256' };
}

export function tokenDurationSeconds(value: string | number, setting: string): number {
  const units: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const match = typeof value === 'string' ? /^(\d+)([smhdw]?)$/.exec(value.trim()) : null;
  const seconds =
    typeof value === 'number'
      ? value
      : match
        ? Number(match[1]) * (units[match[2] || 's'] ?? 1)
        : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${setting} must be positive seconds or a duration such as 15m or 7d.`);
  }
  return seconds;
}
