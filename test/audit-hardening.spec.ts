import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
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
}

function createContext(
  key: string | undefined,
  url: string,
  body: Readonly<Record<string, unknown>>,
): ExecutionContext {
  const request = {
    method: 'POST',
    url,
    body,
    headers: key ? { 'idempotency-key': key } : {},
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
    const interceptor = new IdempotencyInterceptor(
      redis as unknown as RedisService,
    );
    const next: CallHandler = { handle: () => of({ success: true }) };

    await assert.rejects(
      interceptor.intercept(createContext(undefined, '/drills/submit', {}), next),
      BadRequestException,
    );
  });

  it('rejects reuse of a key with a different request payload', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(
      redis as unknown as RedisService,
    );
    const next: CallHandler = { handle: () => of({ success: true }) };
    const key = 'stable-idempotency-key-1';

    const first = await interceptor.intercept(
      createContext(key, '/free-agents/join', { role: 'BOWLER' }),
      next,
    );
    await firstValueFrom(first);

    await assert.rejects(
      interceptor.intercept(
        createContext(key, '/free-agents/join', { role: 'BATSMAN' }),
        next,
      ),
      ConflictException,
    );
  });

  it('scopes the same key independently to each mutation route', async () => {
    const redis = new InMemoryRedis();
    const interceptor = new IdempotencyInterceptor(
      redis as unknown as RedisService,
    );
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
});
