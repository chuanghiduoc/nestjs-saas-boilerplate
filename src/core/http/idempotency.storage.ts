import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestStatusEnum } from '@node-idempotency/core';
import type { StorageAdapter } from '@node-idempotency/storage';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * N4: gắn owner token (sinh mỗi request, trước khi gọi `engine.onRequest`) vào giá trị Redis ghi ở
 * `setIfNotExists`, để `release` chỉ xoá đúng khoá của CHÍNH request đang giữ nó (compare-and-delete), không xoá
 * khoá của một request khác đã giành lại cùng key sau khi khoá cũ hết `IDEMPOTENCY_LOCK_TTL_SEC`. Thư viện
 * `@node-idempotency` chỉ lộ `StorageAdapter` (không có tham số phụ ở `setIfNotExists`), nên token đi qua
 * `AsyncLocalStorage`: nó theo đúng promise chain của lời gọi (an toàn giữa nhiều request đang chạy đồng thời trên
 * cùng interceptor singleton), không phải một field/Map trên `this` (sẽ lẫn giữa các request cùng key).
 */
export const idempotencyOwnerContext = new AsyncLocalStorage<string>();

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
 * KEYS[1] = key, ARGV[1] = trạng thái "đang chạy", ARGV[2] = owner token của CHÍNH request đang release.
 * `cjson` có sẵn trong mọi bản Redis có scripting.
 *
 * N4: so cả `status` lẫn `_owner` trước khi xoá (compare-and-delete). Không có bước này, một request đã hết
 * `IDEMPOTENCY_LOCK_TTL_SEC` mới release (VD. process treo, GC lâu) có thể xoá khoá của một request KHÁC đã giành
 * lại đúng key đó và đang chạy — hai lần chạy cùng key chồng nhau, chỉ còn UNIQUE của DB (nếu có) ngăn ghi kép.
 */
const RELEASE_IN_PROGRESS = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, rec = pcall(cjson.decode, v)
if ok and type(rec) == 'table' and rec.status == ARGV[1] and rec._owner == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

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
    const owner = idempotencyOwnerContext.getStore();
    if (owner === undefined)
      throw new Error(
        'Idempotency storage: setIfNotExists ran outside idempotencyOwnerContext (N4 owner fencing needs a token)',
      );
    // N4: gắn owner vào bản ghi IN_PROGRESS; các field của thư viện (status, fingerPrint) giữ nguyên nên nó vẫn
    // đọc lại được record như cũ, chỉ thêm một field `_owner` mà nó không biết tới (JSON.parse bỏ qua field lạ).
    const augmented = JSON.stringify({ ...JSON.parse(val), _owner: owner });
    const px = Math.min(this.lockTtlMs, ttlMs(options));
    return (await this.redis.set(key, augmented, 'PX', px, 'NX')) === 'OK';
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

  /**
   * Review M3 + N4: xoá khoá "đang chạy" để request sau cùng key chạy lại handler. Nguyên tử (Lua), fenced bằng owner
   * token: chỉ xoá bản ghi còn `IN_PROGRESS` VÀ mang đúng `owner` của CHÍNH lần `setIfNotExists` đã tạo ra nó — không
   * bao giờ xoá response đã lưu (`COMPLETE`) của request khác, và không xoá khoá của một request KHÁC đã giành lại
   * đúng key này sau khi khoá của mình tự hết hạn (`IDEMPOTENCY_LOCK_TTL_SEC`). Trả `true` khi đã xoá.
   */
  async release(key: string, owner: string): Promise<boolean> {
    const deleted = await this.redis.eval(
      RELEASE_IN_PROGRESS,
      1,
      key,
      RequestStatusEnum.IN_PROGRESS,
      owner,
    );
    return deleted === 1;
  }
}
