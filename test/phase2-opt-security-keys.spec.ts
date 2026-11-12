import 'reflect-metadata';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { sign, verify } from 'jsonwebtoken';
import { loadLocalJwtKeys } from '../src/modules/auth/jwt-keys';
import { validateEnvironment } from '../src/config/validate-environment';
import { createAuthFixture, createAuthPassportApp, TEST_DOCUMENT } from './helpers/auth-passport.fixture';

function mockConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, defaultValue?: T): T =>
      (key in values ? values[key] : defaultValue) as T,
  } as unknown as ConfigService;
}

describe('Phase 2 Task 1: RSA-3072 Key Loading, Rotation & Build Hardening', () => {
  const rsa3072 = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const otherRsa3072 = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('loads RSA-3072 key pairs from inline, backslash-n escaped, and base64 env secrets', () => {
    const inline = loadLocalJwtKeys(
      mockConfig({
        'auth.jwtPrivateKey': rsa3072.privateKey,
        'auth.jwtPublicKey': rsa3072.publicKey,
      }),
    );
    assert.strictEqual(inline.algorithm, 'RS256');

    const escaped = loadLocalJwtKeys(
      mockConfig({
        'auth.jwtPrivateKey': rsa3072.privateKey.replaceAll('\n', '\\n'),
        'auth.jwtPublicKey': rsa3072.publicKey.replaceAll('\n', '\\n'),
      }),
    );
    assert.strictEqual(escaped.algorithm, 'RS256');

    const base64Loaded = loadLocalJwtKeys(
      mockConfig({
        'auth.jwtPrivateKey': Buffer.from(rsa3072.privateKey, 'utf8').toString('base64'),
        'auth.jwtPublicKey': Buffer.from(rsa3072.publicKey, 'utf8').toString('base64'),
      }),
    );
    assert.strictEqual(base64Loaded.algorithm, 'RS256');

    const token = sign({ sub: 'athlete-1', role: 'ATHLETE' }, base64Loaded.signingKey, {
      algorithm: 'RS256',
      expiresIn: 60,
    });
    const decoded = verify(token, base64Loaded.verificationKey, { algorithms: ['RS256'] }) as {
      sub: string;
    };
    assert.strictEqual(decoded.sub, 'athlete-1');
  });

  it('rejects partial, weak (<2048-bit), or mismatched RSA key pairs', () => {
    assert.throws(
      () => loadLocalJwtKeys(mockConfig({ 'auth.jwtPrivateKey': rsa3072.privateKey })),
      /Both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY/,
    );
    assert.throws(
      () =>
        loadLocalJwtKeys(
          mockConfig({
            'auth.jwtPrivateKey': rsa3072.privateKey,
            'auth.jwtPublicKey': otherRsa3072.publicKey,
          }),
        ),
      /does not match/,
    );
    const weakRsa1024 = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    assert.throws(
      () =>
        loadLocalJwtKeys(
          mockConfig({
            'auth.jwtPrivateKey': weakRsa1024.privateKey,
            'auth.jwtPublicKey': weakRsa1024.publicKey,
          }),
        ),
      /at least 2048 bits/,
    );
  });

  it('signs with RS256 and rejects tokens from rotated/old keys via JwtStrategy + Fastify HTTP', async () => {
    const fixture = createAuthFixture({
      config: {
        'auth.jwtPrivateKey': Buffer.from(rsa3072.privateKey, 'utf8').toString('base64'),
        'auth.jwtPublicKey': Buffer.from(rsa3072.publicKey, 'utf8').toString('base64'),
      },
    });
    const loginRes = await fixture.auth.login({
      email: fixture.state.user.email!,
      governmentId: { idType: 'AADHAAR' as never, idNumber: TEST_DOCUMENT },
    });
    const verified = verify(loginRes.accessToken, rsa3072.publicKey, { algorithms: ['RS256'] }) as {
      sub: string;
    };
    assert.strictEqual(verified.sub, fixture.state.user.id);
    assert.throws(() => verify(loginRes.accessToken, otherRsa3072.publicKey, { algorithms: ['RS256'] }));

    const app = await createAuthPassportApp(fixture);
    try {
      const okRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${loginRes.accessToken}` },
      });
      assert.strictEqual(okRes.statusCode, 200, okRes.body);

      const oldKeyToken = sign(
        { sub: fixture.state.user.id, role: 'ATHLETE' },
        otherRsa3072.privateKey,
        { algorithm: 'RS256', expiresIn: 900 },
      );
      const rejectedRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${oldKeyToken}` },
      });
      assert.strictEqual(rejectedRes.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('enforces valid RSA key pairs in validateEnvironment for production deployments', () => {
    const baseProdEnv = {
      NODE_ENV: 'production',
      IDENTITY_PEPPER: randomBytes(32).toString('hex'),
      DRILL_HMAC_SECRET: randomBytes(32).toString('hex'),
      TELEMETRY_SERVICE_HMAC_SECRET: randomBytes(32).toString('hex'),
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/kheleo?schema=public',
      CORS_ORIGINS: 'https://app.example.com',
      REDIS_URL: 'rediss://default:pass@localhost:6380/0',
    };

    assert.throws(() => validateEnvironment({ ...baseProdEnv }), /JWT_PRIVATE_KEY_PATH/);

    assert.throws(
      () =>
        validateEnvironment({
          ...baseProdEnv,
          JWT_PRIVATE_KEY: Buffer.from(rsa3072.privateKey, 'utf8').toString('base64'),
          JWT_PUBLIC_KEY: Buffer.from(otherRsa3072.publicKey, 'utf8').toString('base64'),
        }),
      /does not match/,
    );

    assert.doesNotThrow(() =>
      validateEnvironment({
        ...baseProdEnv,
        JWT_PRIVATE_KEY: Buffer.from(rsa3072.privateKey, 'utf8').toString('base64'),
        JWT_PUBLIC_KEY: Buffer.from(rsa3072.publicKey, 'utf8').toString('base64'),
      }),
    );
  });

  it('excludes private keys from Dockerfile build layers, .gitignore, and .dockerignore', () => {
    const root = resolve(__dirname, '..');
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
    const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
    assert.equal(dockerfile.includes('COPY keys'), false);
    assert.equal(dockerfile.includes('openssl genrsa'), false);
    assert.equal(dockerfile.includes('/app/keys'), false);
    assert.match(gitignore, /^keys\/$/m);
    assert.match(dockerignore, /^keys$/m);
  });
});
