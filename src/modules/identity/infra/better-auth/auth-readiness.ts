import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { appConfig, type ConfigOf } from '../../../../core/config/index.js';
import {
  STATEMENT_TIMEOUT_SQL,
  StatementTimeoutReporter,
  statementTimeoutProblem,
} from '../../../../core/database/index.js';
import {
  ReadinessContributor,
  healthConfig,
  type ReadinessProbe,
} from '../../../../core/health/index.js';
import {
  authDatabaseConfig,
  type AuthDatabaseConfig,
} from '../../identity.config.js';
import { AUTH_POOL } from './auth-pool.provider.js';

/**
 * Review M4 (S2-R60): deadline phía client chỉ an toàn khi `statement_timeout` của `auth_user` NHỎ hơn nó (pg không gửi
 * CancelRequest khi `query_timeout` hết; huỷ socket không dừng backend, lock phía server còn giữ). S2-R70: câu SQL, phép so
 * (`statementTimeoutProblem`) và cách báo (`StatementTimeoutReporter`) là của core, dùng chung với readiness `database`.
 */
const AUTH_QUERY_DEADLINE_KEY = 'DB_AUTH_QUERY_TIMEOUT_MS';

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
 *
 * Review M4: probe đọc `statement_timeout` thật thay cho `SELECT 1` (cùng một round trip) và kiểm
 * `statementTimeoutProblem`. Production: vi phạm là probe thất bại (readiness `auth_database` down, log error) — kiểm ở
 * mỗi probe chứ không chỉ lúc boot, vì boot vẫn chạy khi DB auth chưa lên (degraded) và role có thể bị sửa sau đó.
 * Ngoài production chỉ log error một lần mỗi process: test/dev cố ý dùng deadline ngắn hơn `statement_timeout` của DB
 * dùng chung (vd. `Query read timeout` trên DB khoẻ của S2-R65), và probe hỏng thì mọi 500 mơ hồ thành 503.
 */
@Injectable()
@ReadinessContributor('auth_database')
export class AuthDatabaseReadiness implements ReadinessProbe {
  private readonly reporter: StatementTimeoutReporter;
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(healthConfig.KEY)
    private readonly health: ConfigOf<typeof healthConfig>,
    @Inject(authDatabaseConfig.KEY)
    private readonly auth: AuthDatabaseConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
  ) {
    this.reporter = new StatementTimeoutReporter(
      new Logger(AuthDatabaseReadiness.name),
      'auth_statement_timeout_misconfigured',
      app.nodeEnv,
    );
  }

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
    let settingMs: number;
    try {
      const { rows } = await Promise.race([
        client.query<{ setting: string }>(STATEMENT_TIMEOUT_SQL),
        failure,
      ]);
      settingMs = Number(rows[0]?.setting);
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
    this.checkStatementTimeout(settingMs);
  }

  private checkStatementTimeout(settingMs: number): void {
    this.reporter.report(
      statementTimeoutProblem(this.auth.user, settingMs, {
        key: AUTH_QUERY_DEADLINE_KEY,
        ms: this.auth.queryTimeoutMs,
      }),
      { settingMs },
    );
  }
}
