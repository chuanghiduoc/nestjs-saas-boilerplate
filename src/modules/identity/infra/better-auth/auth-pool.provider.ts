import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import {
  metrics,
  type ObservableGauge,
  type ObservableResult,
} from '@opentelemetry/api';
import type pg from 'pg';
import { IDENTITY_METER } from '../../identity-telemetry.js';
import { appConfig, type ConfigOf } from '../../../../core/config/index.js';
import {
  abandonedCheckoutDelayMs,
  databaseConfig,
} from '../../../../core/database/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import {
  authDatabaseConfig,
  type AuthDatabaseConfig,
} from '../../identity.config.js';
import { openAuthPool, type AuthPoolHandle } from './auth-pool.js';

export const AUTH_POOL = Symbol('identity.authPool');
const AUTH_POOL_HANDLE = Symbol('identity.authPoolHandle');

/**
 * Đóng pool sau khi HTTP/job đã dừng (onApplicationShutdown chạy sau beforeApplicationShutdown). `pool.end()` chờ MỌI
 * client đang được mượn được trả: như `CorePoolShutdown` (S2-R70 M3), hết `abandonedCheckoutDelayMs` kể từ lúc tắt máy
 * bắt đầu mà client nào còn được mượn thì nó đã bị bỏ rơi → trả về pool kèm lỗi, để `pool.end()` xong trong phần dự trữ.
 */
@Injectable()
export class AuthPoolLifecycle
  implements OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(AuthPoolLifecycle.name);
  private releaseTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(AUTH_POOL_HANDLE) private readonly handle: AuthPoolHandle,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  onModuleDestroy(): void {
    const afterMs = abandonedCheckoutDelayMs(this.app);
    this.releaseTimer = setTimeout(() => {
      const released = this.handle.checkouts.releaseAll(
        `still checked out ${afterMs} ms into shutdown`,
      );
      if (released > 0)
        this.logger.warn(
          {
            event: 'auth_pool_checkouts_released_at_shutdown',
            released,
            afterMs,
          },
          'auth pool connections still checked out after the shutdown drain; destroyed so the pool can close',
        );
    }, afterMs);
    // Không giữ process sống: nếu mọi thứ đã đóng thì không còn gì để trả.
    this.releaseTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.handle.pool.end();
    } finally {
      clearTimeout(this.releaseTimer);
    }
  }
}

const POOL_STATES = ['total', 'idle', 'waiting'] as const;

/** Gauge của pool `auth_user` (spec §5.14): callback chỉ đọc bộ đếm trong RAM của `pg.Pool`, không I/O. */
@Injectable()
export class AuthPoolMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly gauge: ObservableGauge = metrics
    .getMeter(IDENTITY_METER)
    .createObservableGauge('identity_auth_pool_connections', {
      description:
        'Connections of the auth_user pool by state (waiting = callers queued for a connection)',
    });
  private readonly observe = (r: ObservableResult): void => {
    const counts = {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    } satisfies Record<(typeof POOL_STATES)[number], number>;
    for (const state of POOL_STATES) r.observe(counts[state], { state });
  };
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  onModuleInit(): void {
    this.gauge.addCallback(this.observe);
  }
  onModuleDestroy(): void {
    this.gauge.removeCallback(this.observe);
  }
}

export const authPoolProviders: Provider[] = [
  {
    provide: AUTH_POOL_HANDLE,
    inject: [authDatabaseConfig.KEY, databaseConfig.KEY, httpConfig.KEY],
    // Hạn giữ checkout = ngân sách HTTP (parity với pool core của api, S2-R60 round 6).
    useFactory: (
      auth: AuthDatabaseConfig,
      db: ConfigOf<typeof databaseConfig>,
      http: ConfigOf<typeof httpConfig>,
    ) => openAuthPool(auth, db, http.requestBudgetMs),
  },
  {
    provide: AUTH_POOL,
    inject: [AUTH_POOL_HANDLE],
    useFactory: (handle: AuthPoolHandle) => handle.pool,
  },
  AuthPoolLifecycle,
  AuthPoolMetrics,
];
