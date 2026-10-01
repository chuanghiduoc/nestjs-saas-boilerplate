import { type FactoryProvider, Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  RateLimitBuckets,
  clientIpTracker,
  type RateLimitBucket,
} from '../../../core/http/index.js';
import { tenancyConfig } from '../tenancy.config.js';

/** Token của handle bucket `tenancy.token-preview` (một instance mỗi app; đăng ký ở provider singleton, review C1 của 3A). */
export const TOKEN_PREVIEW_BUCKET = Symbol('tenancy.token-preview');
export const tokenPreviewBucketProvider: FactoryProvider<RateLimitBucket> = {
  provide: TOKEN_PREVIEW_BUCKET,
  inject: [RateLimitBuckets, tenancyConfig.KEY],
  useFactory: (
    buckets: RateLimitBuckets,
    cfg: ConfigOf<typeof tenancyConfig>,
  ): RateLimitBucket =>
    buckets.register({
      owner: 'tenancy',
      name: 'token-preview',
      ttlMs: cfg.tokenPreviewTtlMs,
      limit: cfg.tokenPreviewLimit,
      refundable: false,
    }),
};

/**
 * Spec §7.2 (INT-I8): hai route preview là public nên giới hạn theo IP (`clientIpTracker`, cùng khoá IP với throttler;
 * khoá IP cả khi request có principal), mỗi lần preview đếm một lượt. Token 256 bit nên bucket chống tải DB/quét, không
 * phải chống đoán. Redis lỗi → storage rơi sang insurance trong process (SP1), chỉ lỗi cả hai mới `503`.
 */
@Injectable()
export class TokenPreviewLimiter {
  constructor(
    @Inject(TOKEN_PREVIEW_BUCKET) private readonly bucket: RateLimitBucket,
  ) {}

  async consume(ip: unknown): Promise<void> {
    const d = await this.bucket.consume(clientIpTracker(ip));
    if (d.blocked)
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(d.retryAfterSec) },
        expected: true,
      });
  }
}
