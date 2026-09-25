import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { REDIS, type RedisClient } from '../redis/index.js';
import { healthConfig } from './health.config.js';

/**
 * Các check của readiness: DB (connection `app`) và Redis dùng chung. Dùng
 * `HealthIndicatorService.check(key).attempt(fn).withTimeout(ms)` của terminus: lỗi hoặc quá
 * `HEALTH_CHECK_TIMEOUT_MS` thì indicator `down`. Thông điệp lỗi chỉ vào log server (terminus và
 * ProblemDetailsFilter), không ra response (xem HealthController, WorkerHealthServer).
 */
@Injectable()
export class Readiness {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  indicators(): (() => Promise<HealthIndicatorResult>)[] {
    return [
      () => this.probe('database', () => this.db.execute('SELECT 1')),
      () => this.probe('redis', () => this.redis.ping()),
    ];
  }

  private async probe(
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<HealthIndicatorResult> {
    // Bỏ giá trị trả về: kết quả SELECT/PING không thuộc về body của health check.
    return this.indicator
      .check(key)
      .attempt(async () => {
        await fn();
      })
      .withTimeout(this.cfg.checkTimeoutMs);
  }
}
