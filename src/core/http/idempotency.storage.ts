import type { StorageAdapter } from '@node-idempotency/storage';
import type { Redis } from 'ioredis';

/** @node-idempotency truyền `ttl` = `cacheTTLMS` (mili giây). Không có ttl là lỗi lập trình: không lưu key vĩnh viễn. */
function ttlMs(options: { ttl?: number } | undefined): number {
  const ttl = options?.ttl;
  if (ttl === undefined || !Number.isInteger(ttl) || ttl <= 0)
    throw new Error(
      `Idempotency storage requires a positive integer ttl in ms, got ${String(ttl)}`,
    );
  return ttl;
}

/**
 * `StorageAdapter` của @node-idempotency trên ioredis dùng chung. Key đã mang namespace qua
 * option `cacheKeyPrefix` của thư viện. `setIfNotExists` là một lệnh `SET NX PX` nguyên tử:
 * hai request trùng key chỉ một bên giữ được khoá.
 */
export class RedisIdempotencyStorage implements StorageAdapter {
  constructor(private readonly redis: Redis) {}

  async setIfNotExists(
    key: string,
    val: string,
    options?: { ttl?: number },
  ): Promise<boolean> {
    return (
      (await this.redis.set(key, val, 'PX', ttlMs(options), 'NX')) === 'OK'
    );
  }

  async set(
    key: string,
    val: string,
    options: { ttl?: number },
  ): Promise<void> {
    await this.redis.set(key, val, 'PX', ttlMs(options));
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.redis.get(key)) ?? undefined;
  }
}
