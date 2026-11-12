import { ConfigService } from '@nestjs/config';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

interface LocalJwtKeys {
  readonly signingKey: string;
  readonly verificationKey: string;
  readonly algorithm: 'RS256' | 'HS256';
}

export function normalizePemSecret(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed.includes('-----BEGIN ')) {
    return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  return decoded.includes('-----BEGIN ') ? decoded : trimmed;
}

export function validateRsaKeyPairPem(privatePem: string, publicPem: string): void {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  if (privateKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('JWT key pair must use RSA keys.');
  }
  const modulusBits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < 2048) {
    throw new Error('JWT RSA private key modulus must be at least 2048 bits (3072 bits recommended).');
  }
  const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const providedPublic = publicKey.export({ type: 'spki', format: 'pem' });
  if (derivedPublic !== providedPublic) {
    throw new Error('JWT private key does not match the configured JWT public key.');
  }
}

export function loadLocalJwtKeys(config: ConfigService): LocalJwtKeys {
  const rawPrivateKey = normalizePemSecret(config.get<string>('auth.jwtPrivateKey', ''));
  const rawPublicKey = normalizePemSecret(config.get<string>('auth.jwtPublicKey', ''));
  if (Boolean(rawPrivateKey) !== Boolean(rawPublicKey)) {
    throw new Error('Both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be provided.');
  }
  if (rawPrivateKey && rawPublicKey) {
    validateRsaKeyPairPem(rawPrivateKey, rawPublicKey);
    return {
      signingKey: rawPrivateKey,
      verificationKey: rawPublicKey,
      algorithm: 'RS256',
    };
  }

  const privatePath = config.get<string>('auth.jwtPrivateKeyPath', './keys/private.pem');
  const publicPath = config.get<string>('auth.jwtPublicKeyPath', './keys/public.pem');
  const hasPrivate = Boolean(privatePath) && existsSync(privatePath);
  const hasPublic = Boolean(publicPath) && existsSync(publicPath);
  if (hasPrivate !== hasPublic) {
    throw new Error('Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must exist.');
  }
  if (hasPrivate) {
    const signingKey = normalizePemSecret(readFileSync(privatePath, 'utf8'));
    const verificationKey = normalizePemSecret(readFileSync(publicPath, 'utf8'));
    validateRsaKeyPairPem(signingKey, verificationKey);
    return {
      signingKey,
      verificationKey,
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
