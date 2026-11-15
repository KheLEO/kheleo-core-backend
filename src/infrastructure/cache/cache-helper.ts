const REDIS_OP_TIMEOUT_MS = 350;
const invalidationEpochs = new Map<string, number>();
const inflightLoads = new Map<string, { epoch: number; promise: Promise<unknown> }>();
const pendingMutations = new Map<string, Promise<void>>();

// Keep an already-started SET ahead of its invalidating DEL, even if the caller times out.
function mutateCache(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingMutations.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  pendingMutations.set(key, pending);
  void pending
    .finally(() => {
      if (pendingMutations.get(key) === pending) pendingMutations.delete(key);
    })
    .catch(() => {});
  return pending;
}

export interface CacheClientLike {
  readonly isCacheEnabled?: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr?(key: string): Promise<number>;
}

export const CACHE_KEYS = {
  authUser: (userId: string): string => `auth:v1:user:${userId}`,
  regionalHeatmap: (): string => 'heatmap:v1:regional',
  passport: (userId: string): string => `passport:v1:${userId}`,
  leaderboardVersion: (): string => 'leaderboard:v1:ver',
  leaderboardPage: (
    ver: string,
    scopeKey: string,
    cursor: string | undefined,
    limit: number,
  ): string => `leaderboard:v1:page:${ver}:${scopeKey}:${cursor ?? 'start'}:${limit}`,
  tournamentsVersion: (): string => 'tournaments:v1:ver',
  nearbyTournaments: (ver: string, signature: string): string =>
    `tournaments:v1:nearby:${ver}:${signature}`,
  organizerVersion: (scopeId: string): string => `organizer:v1:ver:${scopeId}`,
  organizerSummary: (ver: string, scopeId: string): string =>
    `organizer:v1:summary:${ver}:${scopeId}`,
} as const;

export function isCacheActive(redis: unknown): redis is CacheClientLike {
  if (!redis || typeof redis !== 'object') return false;
  const candidate = redis as Partial<CacheClientLike>;
  return (
    candidate.isCacheEnabled === true &&
    typeof candidate.get === 'function' &&
    typeof candidate.set === 'function' &&
    typeof candidate.del === 'function'
  );
}

async function withBoundedTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis cache operation timed out')),
          REDIS_OP_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-flight stampede-protected read-through cache backed by Redis.
 * Automatically falls back to `loader()` on Redis timeouts, outages, or malformed payloads.
 */
export async function readThroughCache<T>(
  redis: unknown,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const active = isCacheActive(redis) ? redis : null;
  if (!active) {
    return loader();
  }
  const epoch = invalidationEpochs.get(key) ?? 0;
  try {
    const pending = pendingMutations.get(key);
    if (pending) await withBoundedTimeout(pending);
    const raw = await withBoundedTimeout(active.get(key));
    if ((invalidationEpochs.get(key) ?? 0) !== epoch) {
      return readThroughCache(redis, key, ttlSeconds, loader);
    }
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  } catch {
    // Redis error/timeout/corruption falls back to source loader cleanly.
  }

  const inflight = inflightLoads.get(key);
  if (inflight?.epoch === epoch) {
    return inflight.promise as Promise<T>;
  }

  const loadPromise = (async () => {
    const value = await loader();
    try {
      await withBoundedTimeout(
        mutateCache(key, async () => {
          if ((invalidationEpochs.get(key) ?? 0) === epoch) {
            await active.set(key, JSON.stringify(value), ttlSeconds);
          }
        }),
      );
    } catch {
      // Ignore cache write errors; DB remains authoritative.
    }
    return value;
  })().finally(() => {
    if (inflightLoads.get(key)?.promise === loadPromise) inflightLoads.delete(key);
  });

  inflightLoads.set(key, { epoch, promise: loadPromise });
  return loadPromise;
}

export async function readVersion(redis: unknown, versionKey: string): Promise<string> {
  if (!isCacheActive(redis)) return '0';
  try {
    return (await withBoundedTimeout(redis.get(versionKey))) ?? '0';
  } catch {
    return '0';
  }
}

export async function bumpVersion(redis: unknown, versionKey: string): Promise<void> {
  if (!isCacheActive(redis)) return;
  try {
    if (typeof redis.incr === 'function') {
      await withBoundedTimeout(redis.incr(versionKey));
    } else {
      await withBoundedTimeout(redis.set(versionKey, String(Date.now()), 86400));
    }
  } catch {
    // Ignore version bump errors on Redis outage.
  }
}

export async function invalidateCacheKeys(redis: unknown, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    invalidationEpochs.set(key, (invalidationEpochs.get(key) ?? 0) + 1);
    inflightLoads.delete(key);
  }
  if (!isCacheActive(redis) || keys.length === 0) return;
  await Promise.all(
    keys.map(async (key) => {
      try {
        await withBoundedTimeout(mutateCache(key, () => redis.del(key)));
      } catch {
        // Fail open cleanly if Redis is unreachable.
      }
    }),
  );
}

export async function invalidateAuthAndPassport(redis: unknown, userId: string): Promise<void> {
  await invalidateCacheKeys(redis, [CACHE_KEYS.authUser(userId), CACHE_KEYS.passport(userId)]);
}
