import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from '../src/common/interceptors/idempotency.interceptor';
import { RedisService } from '../src/infrastructure/cache/redis.service';

interface TestReply {
  statusCode: number;
  header(name: string, value: string): TestReply;
  status(code: number): TestReply;
}

class InMemoryRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async setnx(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async deleteIfValueMatches(key: string, expectedValue: string): Promise<boolean> {
    if (this.values.get(key) !== expectedValue) return false;
    return this.values.delete(key);
  }
}

interface RequestOptions {
  readonly actorId?: string;
  readonly deviceSignature?: string | readonly string[];
  readonly ip?: string;
  readonly method?: string;
}

function createContext(
  key: string | undefined,
  url: string,
  body: Readonly<Record<string, unknown>>,
  options: RequestOptions = {},
): ExecutionContext {
  const request = {
    method: options.method ?? 'POST',
    url,
    body,
    ip: options.ip ?? '127.0.0.1',
    user: options.actorId ? { sub: options.actorId } : undefined,
    headers: {
      ...(key ? { 'idempotency-key': key } : {}),
      ...(options.deviceSignature ? { 'x-device-signature': options.deviceSignature } : {}),
    },
  };
  const reply: TestReply = {
    statusCode: 201,
    header: () => reply,
    status: (code: number) => {
      reply.statusCode = code;
      return reply;
    },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('Audit hardening regressions', () => {
  it('requires an idempotency key on protected mutations', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };

    await assert.rejects(
      interceptor.intercept(createContext(undefined, '/drills/submit', {}), next),
      BadRequestException,
    );
  });

  it('rejects reuse of a key with a different request payload', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'stable-idempotency-key-1';

    const first = await interceptor.intercept(
      createContext(key, '/free-agents/join', { role: 'BOWLER' }),
      next,
    );
    await firstValueFrom(first);

    await assert.rejects(
      interceptor.intercept(createContext(key, '/free-agents/join', { role: 'BATSMAN' }), next),
      ConflictException,
    );
  });

  it('scopes the same key independently to each mutation route', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'stable-idempotency-key-2';

    const first = await interceptor.intercept(
      createContext(key, '/auth/register', { phone: '+919000000001' }),
      next,
    );
    await firstValueFrom(first);
    const second = await interceptor.intercept(
      createContext(key, '/drills/submit', { form_score: 90 }),
      next,
    );
    await firstValueFrom(second);

    assert.strictEqual(
      [...redis.values.keys()].filter((keyName) => keyName.startsWith('idempotency:')).length,
      2,
    );
  });

  it('isolates athlete-A and athlete-B caches and active locks for identical requests', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const key = 'same-cross-user-idempotency-key';
    const url = '/api/v1/free-agents/join?bracket=one';
    const body = { role: 'BOWLER' };
    const executions: string[] = [];
    const handler = (actorId: string): CallHandler => ({
      handle: () => {
        executions.push(actorId);
        return of({ registrationId: `registration-${actorId}`, owner: actorId });
      },
    });
    const contextA = createContext(key, url, body, { actorId: 'athlete-A' });
    const contextB = createContext(key, url, body, { actorId: 'athlete-B' });

    const requestA = await interceptor.intercept(contextA, handler('athlete-A'));
    const requestB = await interceptor.intercept(contextB, handler('athlete-B'));
    assert.strictEqual(
      [...redis.values.keys()].filter((name) => name.startsWith('lock:')).length,
      2,
    );

    const [responseA, responseB] = await Promise.all([
      firstValueFrom(requestA),
      firstValueFrom(requestB),
    ]);
    assert.deepStrictEqual(responseA, {
      registrationId: 'registration-athlete-A',
      owner: 'athlete-A',
    });
    assert.deepStrictEqual(responseB, {
      registrationId: 'registration-athlete-B',
      owner: 'athlete-B',
    });

    assert.deepStrictEqual(
      await firstValueFrom(await interceptor.intercept(contextA, handler('athlete-A'))),
      responseA,
    );
    assert.deepStrictEqual(
      await firstValueFrom(await interceptor.intercept(contextB, handler('athlete-B'))),
      responseB,
    );
    assert.deepStrictEqual(executions, ['athlete-A', 'athlete-B']);
  });

  it('replays canonical JSON despite reordered nested keys and preserves array order', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const executions: string[] = [];
    const next: CallHandler = {
      handle: () => {
        executions.push('executed');
        return of({ success: true });
      },
    };
    const key = 'canonical-json-idempotency-key';
    const original = {
      role: 'BOWLER',
      profile: { age: 20, name: 'A' },
      scores: [{ a: 1, b: 2 }, 3],
    };
    const reordered = {
      scores: [{ b: 2, a: 1 }, 3],
      profile: { name: 'A', age: 20 },
      role: 'BOWLER',
    };
    await firstValueFrom(await interceptor.intercept(createContext(key, '/join', original), next));
    await firstValueFrom(await interceptor.intercept(createContext(key, '/join', reordered), next));
    assert.deepStrictEqual(executions, ['executed']);
    await assert.rejects(
      interceptor.intercept(
        createContext(key, '/join', { ...reordered, scores: [3, { a: 1, b: 2 }] }),
        next,
      ),
      ConflictException,
    );
  });

  it('includes query strings, HTTP methods, devices, and IPs in the request scope', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const executions: string[] = [];
    const next: CallHandler = {
      handle: () => {
        executions.push('executed');
        return of({ sequence: executions.length });
      },
    };
    const key = 'scope-components-idempotency-key';
    const cases: ReadonlyArray<{ readonly url: string; readonly options: RequestOptions }> = [
      { url: '/join?bracket=one', options: {} },
      { url: '/join?bracket=two', options: {} },
      { url: '/join?bracket=one', options: { method: 'PATCH' } },
      { url: '/join?bracket=one', options: { deviceSignature: ['device-A'] } },
      { url: '/join?bracket=one', options: { deviceSignature: 'device-B' } },
      { url: '/join?bracket=one', options: { ip: '127.0.0.2' } },
    ];
    for (const { url, options } of cases) {
      await firstValueFrom(await interceptor.intercept(createContext(key, url, {}, options), next));
    }
    assert.strictEqual(executions.length, cases.length);
  });

  it('uses authenticated identity ahead of an untrusted device header', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'authenticated-scope-idempotency-key';
    const request = await interceptor.intercept(
      createContext(key, '/join', {}, { actorId: 'athlete-A', deviceSignature: 'device-A' }),
      next,
    );
    await firstValueFrom(request);
    const cachedOnly: CallHandler = {
      handle: () => {
        throw new Error('Handler must not execute.');
      },
    };
    await firstValueFrom(
      await interceptor.intercept(
        createContext(key, '/join', {}, { actorId: 'athlete-A', deviceSignature: 'device-B' }),
        cachedOnly,
      ),
    );
  });

  it('blocks a concurrent duplicate from the same actor', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const context = createContext(
      'concurrent-idempotency-key',
      '/join',
      {},
      { actorId: 'athlete-A' },
    );
    const next: CallHandler = { handle: () => of({ success: true }) };
    const first = await interceptor.intercept(context, next);
    await assert.rejects(interceptor.intercept(context, next), ConflictException);
    await firstValueFrom(first);
    assert.strictEqual(
      [...redis.values.keys()].some((name) => name.startsWith('lock:')),
      false,
    );
  });

  for (const fails of [false, true]) {
    it(`preserves a successor lock after lease expiry on ${fails ? 'error' : 'success'}`, async () => {
      const redis = new InMemoryRedis();
      const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
      const failure = new Error('Mutation failed.');
      const next: CallHandler = {
        handle: () => (fails ? throwError(() => failure) : of({ success: true })),
      };
      const request = await interceptor.intercept(
        createContext('lock-expiry-idempotency-key', '/join', {}),
        next,
      );
      const lockEntry = [...redis.values.entries()].find(([name]) => name.startsWith('lock:'));
      assert.ok(lockEntry);
      const [lockKey, ownerToken] = lockEntry;
      assert.match(ownerToken, /^[0-9a-f-]{36}$/);
      redis.values.set(lockKey, 'successor-owner-token');
      if (fails) {
        await assert.rejects(firstValueFrom(request), failure);
      } else {
        await firstValueFrom(request);
      }
      assert.strictEqual(redis.values.get(lockKey), 'successor-owner-token');
    });
  }

  it('releases its own lock after a synchronous handler failure', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    const failure = new Error('Synchronous handler failure.');
    const next: CallHandler = {
      handle: () => {
        throw failure;
      },
    };
    const request = await interceptor.intercept(
      createContext('sync-failure-idempotency-key', '/join', {}),
      next,
    );
    await assert.rejects(firstValueFrom(request), failure);
    assert.strictEqual(redis.values.size, 0);
  });
});
