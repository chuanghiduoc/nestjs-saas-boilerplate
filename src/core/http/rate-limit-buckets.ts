import { Injectable } from '@nestjs/common';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { rateLimitKey } from './client-ip.js';
import {
  RateLimiterThrottlerStorage,
  wholeSeconds,
  type BucketDecision,
} from './rate-limiter.storage.js';

export type { BucketDecision };
/** Không có `.`: dấu `.` nối `<owner>.<name>`, nên tên bucket không bao giờ trùng throttler của `@Throttle`/`default`. */
const PART = /^[a-z][a-z0-9-]{0,31}$/;

export type BucketDef = {
  owner: string;
  name: string;
  ttlMs: number;
  limit: number;
};
/**
 * Ngữ nghĩa của `limit` (hợp đồng cho mọi caller, review I4): `limit` = số lần tiêu điểm được phép trước khi bị khoá.
 * `peek` chỉ báo `blocked` khi số điểm đã tiêu VƯỢT `limit` (`consumedPoints > limit`). Caller theo mẫu "peek → làm việc →
 * consume khi trượt" (như `OrgContextMiddleware`) vì vậy trả lỗi thường (vd. `404`) cho cả lần thứ `limit + 1` — lần
 * consume làm vượt ngưỡng — và chỉ từ lần `limit + 2` mới nhận `429` ở `peek`. Không đổi `peek` thành `>=`.
 */
export interface RateLimitBucket {
  readonly name: string;
  /** Chỉ đọc: không bao giờ tiêu điểm. `blocked` khi số điểm đã tiêu > `limit`. */
  peek(key: string): Promise<BucketDecision>;
  /** Tiêu một điểm; lần làm vượt ngưỡng trả `blocked` (không ném): caller quyết định response. */
  consume(key: string): Promise<BucketDecision>;
}
export interface RefundableRateLimitBucket extends RateLimitBucket {
  refund(key: string): Promise<void>;
}

/**
 * Bucket rate limit ngoài `@Throttle` (spec SP3 §5.2): tham số decorator được đánh giá lúc import (trước khi config
 * nạp), và `@nestjs/throttler` chỉ được import trong `core/http`. Mỗi module đăng ký bucket của mình MỘT lần lúc
 * khởi tạo provider và giữ handle; không có API nào thao tác bucket theo tên, nên không module nào hoàn điểm bucket
 * của module khác (SEC2-N5). Cùng storage của SP1: khoá băm (`rateLimitKey`), insurance theo pod khi Redis lỗi, 503
 * khi cả hai lỗi. `refund` chỉ có trên bucket đăng ký `refundable: true`.
 */
@Injectable()
export class RateLimitBuckets {
  private readonly storage: RateLimiterThrottlerStorage;
  private readonly names = new Set<string>();

  constructor(@InjectThrottlerStorage() storage: ThrottlerStorage) {
    if (!(storage instanceof RateLimiterThrottlerStorage))
      throw new Error(
        'RateLimitBuckets requires the RateLimiterThrottlerStorage of HttpModule',
      );
    this.storage = storage;
  }

  register(def: BucketDef & { refundable: true }): RefundableRateLimitBucket;
  register(def: BucketDef & { refundable: false }): RateLimitBucket;
  register(
    def: BucketDef & { refundable: boolean },
  ): RateLimitBucket | RefundableRateLimitBucket {
    if (!PART.test(def.owner) || !PART.test(def.name))
      throw new Error(
        `Rate limit bucket owner and name must match ${PART}, got "${def.owner}.${def.name}"`,
      );
    if (!Number.isInteger(def.limit) || def.limit < 1)
      throw new Error(
        `Rate limit bucket "${def.owner}.${def.name}" limit must be a positive integer`,
      );
    const name = `${def.owner}.${def.name}`;
    // Cùng kiểm tra với `limiter()` của storage, nhưng lúc boot (đăng ký) thay vì ở request đầu tiên.
    wholeSeconds(def.ttlMs, `bucket "${name}" window`);
    if (this.names.has(name))
      throw new Error(`Rate limit bucket "${name}" is already registered`);
    this.names.add(name);
    const { storage } = this;
    const { ttlMs, limit } = def;
    const keyOf = (key: string) => rateLimitKey(name, key);
    const bucket: RateLimitBucket = {
      name,
      peek: (key) => storage.peek(keyOf(key), ttlMs, limit, ttlMs, name),
      consume: async (key) => {
        const r = await storage.increment(
          keyOf(key),
          ttlMs,
          limit,
          ttlMs,
          name,
        );
        return r.isBlocked
          ? { blocked: true, retryAfterSec: r.timeToBlockExpire }
          : { blocked: false };
      },
    };
    if (!def.refundable) return bucket;
    return {
      ...bucket,
      refund: (key) => storage.refund(keyOf(key), ttlMs, limit, ttlMs, name),
    };
  }
}
