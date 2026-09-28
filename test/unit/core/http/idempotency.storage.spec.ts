import { RequestStatusEnum } from '@node-idempotency/core';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  RedisIdempotencyStorage,
  idempotencyOwnerContext,
} from '../../../../src/core/http/idempotency.storage.js';

const LOCK_TTL_MS = 120_000;
/** `lazyConnect`: không mở kết nối nào; mọi lời gọi Redis trong spec này đều bị spy thay thế (không cần Redis thật). */
const redis = new Redis({ lazyConnect: true });
const storage = new RedisIdempotencyStorage(redis, LOCK_TTL_MS);

const inProgressVal = (fingerPrint = 'fp') =>
  JSON.stringify({ status: RequestStatusEnum.IN_PROGRESS, fingerPrint });

describe('RedisIdempotencyStorage (N4: owner-fenced release)', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => redis.disconnect());

  it('setIfNotExists requires an owner from idempotencyOwnerContext: a call outside it is a programming error, fails loud', async () => {
    await expect(
      storage.setIfNotExists('k1', inProgressVal(), { ttl: 1000 }),
    ).rejects.toThrow(/idempotencyOwnerContext/);
  });

  it('setIfNotExists embeds the owner token into the stored value, keeping the library fields intact', async () => {
    const set = vi.spyOn(redis, 'set').mockResolvedValue('OK');
    const ok = await idempotencyOwnerContext.run('owner-a', () =>
      storage.setIfNotExists('k1', inProgressVal('fp-1'), { ttl: 5000 }),
    );
    expect(ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const [key, storedVal, ...rest] = set.mock.calls[0]!;
    expect(key).toBe('k1');
    expect(JSON.parse(storedVal as string)).toEqual({
      status: RequestStatusEnum.IN_PROGRESS,
      fingerPrint: 'fp-1',
      _owner: 'owner-a',
    });
    expect(rest).toEqual(['PX', Math.min(LOCK_TTL_MS, 5000), 'NX']);
  });

  it('release only deletes a record that still matches both status and owner (compare-and-delete)', async () => {
    const evalSpy = vi.spyOn(redis, 'eval');

    // Simulates a redis.eval that actually runs RELEASE_IN_PROGRESS against a stored record.
    const runLua = (stored: unknown, owner: string) => {
      if (stored === undefined) return 0;
      const rec = stored as { status: string; _owner?: string };
      return rec.status === RequestStatusEnum.IN_PROGRESS &&
        rec._owner === owner
        ? 1
        : 0;
    };

    // Case 1: same owner that acquired the lock — release succeeds.
    evalSpy.mockResolvedValueOnce(
      runLua(
        { status: RequestStatusEnum.IN_PROGRESS, _owner: 'owner-a' },
        'owner-a',
      ),
    );
    expect(await storage.release('k1', 'owner-a')).toBe(true);
    expect(evalSpy).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      'k1',
      RequestStatusEnum.IN_PROGRESS,
      'owner-a',
    );

    // Case 2 (N4 race): a DIFFERENT request now holds the same key (its own lock, after the first owner's TTL
    // elapsed) — the stale release must NOT delete it.
    evalSpy.mockResolvedValueOnce(
      runLua(
        { status: RequestStatusEnum.IN_PROGRESS, _owner: 'owner-b' },
        'owner-a',
      ),
    );
    expect(await storage.release('k1', 'owner-a')).toBe(false);

    // Case 3: no record at all (already released, or never existed).
    evalSpy.mockResolvedValueOnce(runLua(undefined, 'owner-a'));
    expect(await storage.release('k1', 'owner-a')).toBe(false);
  });
});
