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
 *
 * Review fix round 2: client lấy bằng `pool.connect()` KHÔNG có listener `'error'` từ lúc checkout tới lúc
 * `release()` (pg-pool gỡ listener rảnh khi giao client và chỉ gắn lại trong `release`; `Pool.query()` tự gắn
 * listener tạm, còn ở đây phải tự làm). Socket chết khi query còn chạy thì pg phát `'error'` đồng bộ trên
 * client: không có listener là uncaught exception, sập process. Listener ở đây làm probe fail ngay (như
 * timeout) và được gỡ đồng bộ ngay trước `release`, lúc pg-pool gắn lại listener rảnh của nó.
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
    let connectionError: Error | undefined;
    let failProbe: (err: Error) => void = () => undefined;
    const failure = new Promise<never>((_, reject) => {
      failProbe = reject;
    });
    const onError = (err: Error): void => {
      connectionError = err;
      failProbe(err);
    };
    client.on('error', onError);
    const timer = setTimeout(
      () => failProbe(new Error(`auth_database probe exceeded ${ms}ms`)),
      ms,
    );
    try {
      await Promise.race([client.query('SELECT 1'), failure]);
    } catch (err) {
      // Query lỗi, quá hạn hoặc socket chết: huỷ client, không trả về pool. Gỡ listener rồi release trong
      // cùng một tick, nên không có khoảng nào client thiếu listener `'error'`.
      client.off('error', onError);
      client.release(err instanceof Error ? err : true);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    client.off('error', onError);
    // `'error'` tới sau khi query đã xong (cùng tick) vẫn làm client hỏng: huỷ thay vì trả về pool.
    client.release(connectionError);
  }
}
