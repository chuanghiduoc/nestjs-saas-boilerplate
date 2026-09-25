import { RequestStatusEnum } from '@node-idempotency/core';
import type { StorageAdapter } from '@node-idempotency/storage';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** @node-idempotency truyền `ttl` = `cacheTTLMS` (mili giây). Không có ttl là lỗi lập trình: không lưu key vĩnh viễn. */
function ttlMs(options: { ttl?: number } | undefined): number {
  const ttl = options?.ttl;
  if (ttl === undefined || !Number.isInteger(ttl) || ttl <= 0)
    throw new Error(
      `Idempotency storage requires a positive integer ttl in ms, got ${String(ttl)}`,
    );
  return ttl;
}

const Payload = z.object({ status: z.enum(RequestStatusEnum) });

/**
 * Thư viện (1.1.0) chỉ gọi `setIfNotExists` cho bản ghi IN_PROGRESS và `set` cho bản ghi COMPLETE.
 * Kiểm tra lại để một bản thư viện sau đổi hành vi thì fail rõ ràng thay vì âm thầm sai TTL.
 */
function assertStatus(val: string, expected: RequestStatusEnum): void {
  const { status } = Payload.parse(JSON.parse(val));
  if (status !== expected)
    throw new Error(
      `Idempotency storage expected a ${expected} record, got ${status}`,
    );
}

/**
 * `StorageAdapter` của @node-idempotency trên ioredis dùng chung. Key đã mang namespace qua
 * option `cacheKeyPrefix` của thư viện.
 * - `setIfNotExists` (khoá "đang chạy") là một lệnh `SET NX PX` nguyên tử: hai request trùng key chỉ
 *   một bên giữ được khoá. Khoá sống `min(lockTtlMs, ttl)`: process chết giữa chừng chỉ khoá key
 *   trong IDEMPOTENCY_LOCK_TTL_SEC, không phải cả thời gian lưu response.
 * - `set` (response đã xong) giữ đủ `ttl` của thư viện.
 */
export class RedisIdempotencyStorage implements StorageAdapter {
  constructor(
    private readonly redis: Redis,
    private readonly lockTtlMs: number,
  ) {}

  async setIfNotExists(
    key: string,
    val: string,
    options?: { ttl?: number },
  ): Promise<boolean> {
    assertStatus(val, RequestStatusEnum.IN_PROGRESS);
    const px = Math.min(this.lockTtlMs, ttlMs(options));
    return (await this.redis.set(key, val, 'PX', px, 'NX')) === 'OK';
  }

  async set(
    key: string,
    val: string,
    options: { ttl?: number },
  ): Promise<void> {
    assertStatus(val, RequestStatusEnum.COMPLETE);
    await this.redis.set(key, val, 'PX', ttlMs(options));
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.redis.get(key)) ?? undefined;
  }
}
