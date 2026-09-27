import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { type ConfigOf } from '../../../../core/config/index.js';
import {
  ReadinessContributor,
  healthConfig,
  type ReadinessProbe,
} from '../../../../core/health/index.js';
import { AUTH_POOL } from './auth-pool.provider.js';

/**
 * Pool auth chết thì mọi request cần xác thực đều hỏng (spec §5.13). Không có ở `external`.
 *
 * `Readiness` bọc probe bằng `withTimeout(HEALTH_CHECK_TIMEOUT_MS)` của terminus, nhưng timeout đó chỉ
 * trả `down`, không huỷ được query (`ReadinessProbe.probe()` không nhận AbortSignal). Mạng bị blackhole
 * (không RST) thì `SELECT 1` treo tới khi kernel hết TCP timeout và giữ một trong `DB_AUTH_POOL_MAX`
 * client mỗi chu kỳ probe (review Minor 3). Nên probe tự đặt hạn đúng bằng `HEALTH_CHECK_TIMEOUT_MS`:
 * quá hạn thì `release(err)`, pg-pool huỷ client thay vì trả về pool. Chờ connection đã có hạn riêng
 * `DB_AUTH_CONNECTION_TIMEOUT_MS`.
 */
@Injectable()
@ReadinessContributor('auth_database')
export class AuthDatabaseReadiness implements ReadinessProbe {
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(healthConfig.KEY)
    private readonly health: ConfigOf<typeof healthConfig>,
  ) {}

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    const ms = this.health.checkTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`auth_database probe exceeded ${ms}ms`)),
        ms,
      );
    });
    try {
      await Promise.race([client.query('SELECT 1'), deadline]);
      client.release();
    } catch (err) {
      // Client có query dở hoặc lỗi: huỷ, không trả về pool.
      client.release(err instanceof Error ? err : true);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
