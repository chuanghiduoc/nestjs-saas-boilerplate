import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { clientIpTracker } from './client-ip.js';
import {
  RateLimitBuckets,
  type RefundableRateLimitBucket,
} from './rate-limit-buckets.js';
import { throttleConfig } from './throttle.config.js';

/**
 * Giới hạn theo IP client TRƯỚC khi một credential chạm storage xác thực (S2-R51). `AppThrottlerGuard` là guard nên
 * luôn chạy sau middleware xác thực (và không chạy trên path 404): một loạt API key rác vẫn tốn một lookup + probe
 * DB auth mỗi request. Dùng chính `ThrottlerStorage` của SP1 (rate-limiter-flexible trên Redis, insurance trong bộ
 * nhớ khi Redis lỗi) và cùng khoá IP + cách băm khoá với guard (`clientIpTracker`, `rateLimitKey`).
 *
 * S2-R53: `consume` trước xác thực, `refund` khi xác thực THÀNH CÔNG → chỉ credential rác còn đếm; key hợp lệ (nhiều
 * client sau một NAT) không bị giới hạn ở đây mà bởi throttler theo principal sau xác thực. Hai thao tác nguyên tử
 * riêng: trong lúc xác thực, bộ đếm tạm dư (nghiêng về chặt). Giới hạn đã biết: nếu cửa sổ hết hạn giữa consume và
 * refund thì bộ đếm xuống -1, nên người giữ một key hợp lệ canh mép cửa sổ có thể "để dành" tối đa `limit` lần thử
 * rác thêm cho một cửa sổ — có trần, và key đó truy vết/thu hồi được.
 */
@Injectable()
export class PreAuthRateLimiter {
  private readonly logger = new Logger(PreAuthRateLimiter.name);
  private readonly bucket: RefundableRateLimitBucket;

  /**
   * Bucket `core.pre-auth` (spec SP3 §5.2): cùng storage và hành vi S2-R51/R53. Đổi tên trong storage (trước đây
   * `pre-auth`) làm bộ đếm pre-auth về 0 một lần lúc deploy: chấp nhận được.
   */
  constructor(
    buckets: RateLimitBuckets,
    @Inject(throttleConfig.KEY) cfg: ConfigOf<typeof throttleConfig>,
  ) {
    this.bucket = buckets.register({
      owner: 'core',
      name: 'pre-auth',
      ttlMs: cfg.preAuthTtlMs,
      limit: cfg.preAuthLimit,
      refundable: true,
    });
  }

  /**
   * Vượt giới hạn → `429 rate_limited` + `Retry-After` (cùng problem với throttler của SP1). Storage lỗi cả Redis lẫn
   * insurance → storage ném `503` + `Retry-After` (fail closed, cùng hành vi với throttler của route).
   */
  async consume(req: { ip?: unknown }): Promise<void> {
    const d = await this.bucket.consume(clientIpTracker(req.ip));
    if (d.blocked)
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(d.retryAfterSec) },
        expected: true,
      });
  }

  /**
   * Chỉ gọi khi credential đã xác thực thành công. Hoàn điểm lỗi chỉ làm giới hạn chặt hơn: log warn (chỉ tên class),
   * không bao giờ làm hỏng request đã xác thực. IP không xác định vẫn ném ở `clientIpTracker` TRƯỚC `try` (như bản cũ
   * ném ở `keyOf`): không phải lỗi hoàn điểm.
   */
  async refund(req: { ip?: unknown }): Promise<void> {
    const tracker = clientIpTracker(req.ip);
    try {
      await this.bucket.refund(tracker);
    } catch (err) {
      this.logger.warn(
        {
          event: 'pre_auth_refund_failed',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'pre-authentication rate limit refund failed; the limit stays stricter',
      );
    }
  }
}
