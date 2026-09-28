import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { type ConfigOf } from '../config/index.js';
import { DbStatementTimeoutCheck } from '../database/index.js';
import { REDIS, type RedisClient } from '../redis/index.js';
import { healthConfig } from './health.config.js';
import {
  ReadinessContributorMarker,
  isReadinessProbe,
  type ReadinessProbe,
} from './readiness-contributor.js';

export type ReadinessCheck = 'database' | 'redis';
export const READINESS_CHECKS = Symbol('core.health.readinessChecks');
const CORE_CHECKS: readonly string[] = ['database', 'redis'];
const CONTRIBUTOR_KEY = /^[a-z][a-z0-9_]*$/;

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
 *
 * Nest không có multi-provider: module sở hữu (identity, notifications, ...) khai probe của mình
 * bằng `@ReadinessContributor(key)` trên một provider singleton cài `ReadinessProbe`, và `Readiness`
 * tìm chúng qua `DiscoveryService` lúc `onModuleInit` — cùng mẫu với `@JobHandler`/`WorkerHost`. `core`
 * không import module nào để biết trước danh sách; validate key một lần lúc boot, không phải mỗi request.
 */
@Injectable()
export class Readiness implements OnModuleInit {
  private readonly contributors = new Map<string, ReadinessProbe>();

  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly db: DbStatementTimeoutCheck,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
    @Inject(READINESS_CHECKS)
    private readonly checks: readonly ReadinessCheck[],
    private readonly discovery: DiscoveryService,
  ) {}

  /** Validate một lần lúc boot: key sai hoặc trùng là lỗi cấu hình. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: ReadinessContributorMarker.KEY,
    })) {
      const key = this.discovery.getMetadataByDecorator(
        ReadinessContributorMarker,
        wrapper,
      );
      // Chỉ bỏ qua khi không có metadata; key rỗng `''` phải tới được lỗi validate bên dưới, không bị nuốt.
      if (key === undefined) continue;
      if (
        !CONTRIBUTOR_KEY.test(key) ||
        CORE_CHECKS.includes(key) ||
        this.contributors.has(key)
      )
        throw new Error(
          `Invalid or duplicate readiness contributor key "${key}": it must match ${CONTRIBUTOR_KEY}, be unique and not shadow a core check`,
        );
      if (
        !wrapper.isDependencyTreeStatic() ||
        !isReadinessProbe(wrapper.instance)
      )
        throw new Error(
          `@ReadinessContributor(${key}) must be a singleton provider implementing probe()`,
        );
      this.contributors.set(key, wrapper.instance);
    }
  }

  indicators(): (() => Promise<HealthIndicatorResult>)[] {
    return [
      ...this.checks.map((check) => () => this.core(check)),
      ...[...this.contributors].map(
        ([key, p]) =>
          () =>
            this.attempt(key, () => p.probe()),
      ),
    ];
  }

  private core(check: ReadinessCheck): Promise<HealthIndicatorResult> {
    // Bỏ giá trị trả về: kết quả SELECT/PING không thuộc về body của health check.
    const run = async (): Promise<void> => {
      switch (check) {
        case 'database':
          // S2-R70 I3: đọc `statement_timeout` thật (cùng round trip với `SELECT 1`) và kiểm nó dưới deadline phía client.
          await this.db.run(this.cfg.checkTimeoutMs);
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
    return this.attempt(check, run);
  }

  private attempt(
    key: string,
    run: () => Promise<void>,
  ): Promise<HealthIndicatorResult> {
    return Promise.resolve(
      this.indicator
        .check(key)
        .attempt(run)
        .withTimeout(this.cfg.checkTimeoutMs),
    );
  }
}
