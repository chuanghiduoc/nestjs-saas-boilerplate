import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { clientIpTracker, rateLimitKey } from './client-ip.js';
import { RateLimiterThrottlerStorage } from './rate-limiter.storage.js';
import { throttleConfig } from './throttle.config.js';

/** Tên throttler riêng: storage dựng limiter + prefix khoá riêng, không đếm chung với `default` của route. */
const PRE_AUTH_THROTTLER = 'pre-auth';

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
  private readonly storage: RateLimiterThrottlerStorage;
  private readonly ttlMs: number;
  private readonly limit: number;

  constructor(
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(throttleConfig.KEY) cfg: ConfigOf<typeof throttleConfig>,
  ) {
    // Hoàn điểm cần `refund` của storage SP1; storage khác (vd. mặc định của @nestjs/throttler) không có → dừng boot.
    if (!(storage instanceof RateLimiterThrottlerStorage))
      throw new Error(
        'PreAuthRateLimiter requires the RateLimiterThrottlerStorage of HttpModule',
      );
    this.storage = storage;
    this.ttlMs = cfg.preAuthTtlMs;
    this.limit = cfg.preAuthLimit;
  }

  /**
   * Vượt giới hạn → `429 rate_limited` + `Retry-After` (cùng problem với throttler của SP1). Storage lỗi cả Redis lẫn
   * insurance → storage ném `503` + `Retry-After` (fail closed, cùng hành vi với throttler của route).
   */
  async consume(req: { ip?: unknown }): Promise<void> {
    const record = await this.storage.increment(
      this.keyOf(req),
      this.ttlMs,
      this.limit,
      this.ttlMs,
      PRE_AUTH_THROTTLER,
    );
    if (record.isBlocked)
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(record.timeToBlockExpire) },
        expected: true,
      });
  }

  /**
   * Chỉ gọi khi credential đã xác thực thành công. Hoàn điểm lỗi chỉ làm giới hạn chặt hơn: log warn (chỉ tên class),
   * không bao giờ làm hỏng request đã xác thực.
   */
  async refund(req: { ip?: unknown }): Promise<void> {
    try {
      await this.storage.refund(
        this.keyOf(req),
        this.ttlMs,
        this.limit,
        this.ttlMs,
        PRE_AUTH_THROTTLER,
      );
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

  private keyOf(req: { ip?: unknown }): string {
    return rateLimitKey(PRE_AUTH_THROTTLER, clientIpTracker(req.ip));
  }
}
