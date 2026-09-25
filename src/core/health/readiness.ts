import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { REDIS, type RedisClient } from '../redis/index.js';
import { healthConfig } from './health.config.js';

export type ReadinessCheck = 'database' | 'redis';
export const READINESS_CHECKS = Symbol('core.health.readinessChecks');

/**
 * Phụ thuộc mà readiness kiểm tra, theo vai trò process (ruling R21):
 * - api: chỉ DB. Redis dùng chung cả fleet và api chạy suy giảm được khi mất Redis (rate limit
 *   rơi về limiter dự phòng trong process, chỉ route `@Idempotent` trả 503). Gate readiness theo
 *   Redis thì một lần Redis chập chờn rút MỌI pod api khỏi load balancer: suy giảm cục bộ thành
 *   sập toàn bộ.
 * - worker: DB + Redis. Worker không làm được gì khi thiếu Redis (BullMQ).
 */
export const readinessChecksFor = (opts: {
  http: boolean;
}): readonly ReadinessCheck[] =>
  opts.http ? ['database'] : ['database', 'redis'];

/**
 * Dùng `HealthIndicatorService.check(key).attempt(fn).withTimeout(ms)` của terminus: lỗi hoặc quá
 * `HEALTH_CHECK_TIMEOUT_MS` thì indicator `down`. Chi tiết lỗi chỉ vào log server (một dòng warn),
 * không ra response (xem HealthController, WorkerHealthServer).
 */
@Injectable()
export class Readiness {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
    @Inject(READINESS_CHECKS)
    private readonly checks: readonly ReadinessCheck[],
  ) {}

  indicators(): (() => Promise<HealthIndicatorResult>)[] {
    return this.checks.map((check) => () => this.probe(check));
  }

  private probe(check: ReadinessCheck): Promise<HealthIndicatorResult> {
    // Bỏ giá trị trả về: kết quả SELECT/PING không thuộc về body của health check.
    const run = async (): Promise<void> => {
      switch (check) {
        case 'database':
          await this.db.execute('SELECT 1');
          return;
        case 'redis':
          await this.redis.ping();
          return;
        default: {
          const unknown: never = check;
          throw new Error(`unknown readiness check "${String(unknown)}"`);
        }
      }
    };
    return Promise.resolve(
      this.indicator
        .check(check)
        .attempt(run)
        .withTimeout(this.cfg.checkTimeoutMs),
    );
  }
}
