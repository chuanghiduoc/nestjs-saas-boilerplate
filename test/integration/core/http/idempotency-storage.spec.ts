import { randomBytes } from 'node:crypto';
import { RequestStatusEnum } from '@node-idempotency/core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisIdempotencyStorage,
  idempotencyOwnerContext,
} from '../../../../src/core/http/idempotency.storage.js';
import { getInfra } from '../../../support/infra.js';

const LOCK_TTL_MS = 120_000;

/**
 * N4: `release` phải là compare-and-delete theo owner token thật, chống lại một Redis THẬT (Lua chạy trên server, không
 * phải mô phỏng trong test).
 */
describe('RedisIdempotencyStorage owner-fenced release against a real Redis (N4)', () => {
  const key = `idem-owner-${randomBytes(6).toString('hex')}`;
  let redis: Redis;
  let storage: RedisIdempotencyStorage;

  beforeAll(() => {
    redis = new Redis(getInfra().redis.url, { maxRetriesPerRequest: 1 });
    storage = new RedisIdempotencyStorage(redis, LOCK_TTL_MS);
  });
  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  const acquire = (owner: string) =>
    idempotencyOwnerContext.run(owner, () =>
      storage.setIfNotExists(
        key,
        JSON.stringify({
          status: RequestStatusEnum.IN_PROGRESS,
          fingerPrint: 'fp',
        }),
        { ttl: 5000 },
      ),
    );

  it('a stale release (owner A, after A already lost the lock to owner B) does not delete B’s record; B’s own release does', async () => {
    // A acquires the lock, then "dies" without releasing in time (simulated: we just never call A's release
    // until after B has acquired). B can only acquire once the key is gone, so first delete it directly to model
    // A's lock having expired (IDEMPOTENCY_LOCK_TTL_SEC) rather than waiting out a real TTL in the test.
    expect(await acquire('owner-a')).toBe(true);
    await redis.del(key); // A's lock TTL elapsed.
    expect(await acquire('owner-b')).toBe(true);

    // A's belated release must NOT remove B's record (N4 owner fencing).
    expect(await storage.release(key, 'owner-a')).toBe(false);
    expect(await redis.get(key)).not.toBeNull();

    // B's own release succeeds.
    expect(await storage.release(key, 'owner-b')).toBe(true);
    expect(await redis.get(key)).toBeNull();
  });

  it('release never touches a COMPLETE record even if the owner happens to match', async () => {
    expect(await acquire('owner-c')).toBe(true);
    await storage.set(
      key,
      JSON.stringify({
        status: RequestStatusEnum.COMPLETE,
        response: { additional: { headers: {} }, body: {} },
      }),
      { ttl: 5000 },
    );
    expect(await storage.release(key, 'owner-c')).toBe(false);
    expect(await redis.get(key)).not.toBeNull();
    await redis.del(key);
  });
});
