import {
  Inject,
  Injectable,
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
import { type ConfigOf } from '../../../../core/config/index.js';
import { databaseConfig } from '../../../../core/database/index.js';
import {
  authDatabaseConfig,
  type AuthDatabaseConfig,
} from '../../identity.config.js';
import { createAuthPool } from './auth-pool.js';

export const AUTH_POOL = Symbol('identity.authPool');

@Injectable()
export class AuthPoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  /** Đóng sau khi HTTP/job đã dừng (onApplicationShutdown chạy sau beforeApplicationShutdown). */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
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
    provide: AUTH_POOL,
    inject: [authDatabaseConfig.KEY, databaseConfig.KEY],
    useFactory: (
      auth: AuthDatabaseConfig,
      db: ConfigOf<typeof databaseConfig>,
    ) => createAuthPool(auth, db),
  },
  AuthPoolLifecycle,
  AuthPoolMetrics,
];
