import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { clientIpTracker } from './client-ip.js';
import { throttleConfig } from './throttle.config.js';

const MS_PER_SEC = 1000;
/** Tên throttler riêng: storage dựng limiter + prefix khoá riêng, không đếm chung với `default` của route. */
const PRE_AUTH_THROTTLER = 'pre-auth';

/**
 * Giới hạn theo IP client TRƯỚC khi một credential chạm storage xác thực (S2-R51). `AppThrottlerGuard` là guard nên
 * luôn chạy sau middleware xác thực (và không chạy trên path 404): một loạt API key rác vẫn tốn một lookup + probe
 * DB auth mỗi request. Dùng chính `ThrottlerStorage` của SP1 (rate-limiter-flexible trên Redis, insurance trong bộ
 * nhớ khi Redis lỗi) và cùng khoá IP với guard (`clientIpTracker`).
 */
@Injectable()
export class PreAuthRateLimiter {
  private readonly logger = new Logger(PreAuthRateLimiter.name);
  private readonly ttlMs: number;
  private readonly limit: number;

  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    @Inject(throttleConfig.KEY) cfg: ConfigOf<typeof throttleConfig>,
  ) {
    this.ttlMs = cfg.preAuthTtlMs;
    this.limit = cfg.preAuthLimit;
  }

  /**
   * Vượt giới hạn → `429 rate_limited` + `Retry-After` (cùng problem với throttler của SP1). Storage lỗi cả Redis lẫn
   * insurance → `503` + `Retry-After` (fail closed: không bao giờ cho request chưa giới hạn tới storage xác thực).
   */
  async consume(req: { ip?: unknown }): Promise<void> {
    const key = `${PRE_AUTH_THROTTLER}:${clientIpTracker(req.ip)}`;
    let record: Awaited<ReturnType<ThrottlerStorage['increment']>>;
    try {
      record = await this.storage.increment(
        key,
        this.ttlMs,
        this.limit,
        this.ttlMs,
        PRE_AUTH_THROTTLER,
      );
    } catch (err) {
      // Không log khoá (chứa IP) hay message của lỗi: chỉ tên class.
      this.logger.error(
        {
          event: 'pre_auth_rate_limit_unavailable',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'pre-authentication rate limit storage failed; refusing the request',
      );
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: { 'Retry-After': String(this.ttlMs / MS_PER_SEC) },
        expected: true,
      });
    }
    if (record.isBlocked)
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(record.timeToBlockExpire) },
        expected: true,
      });
  }
}
