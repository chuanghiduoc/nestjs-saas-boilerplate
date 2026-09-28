import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/postgresql';
import pg from 'pg';
import { type ConfigOf, appConfig } from '../config/index.js';
import { DB_CONTEXT } from './constants.js';
import { databaseConfig } from './database.config.js';

/**
 * Giá trị THẬT của `statement_timeout` trong session (role, PgBouncer đều tính), đơn vị ms (`pg_settings.unit`). Dùng
 * chung với probe `auth_database` của identity (pool `auth_user`).
 */
export const STATEMENT_TIMEOUT_SQL = `SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`;
const PRODUCTION = 'production';

/**
 * Deadline phía client chỉ an toàn khi `statement_timeout` của role NHỎ hơn nó: pg không gửi CancelRequest khi
 * `query_timeout` hết (client.js:706-731) và huỷ socket không dừng backend. Role không có `statement_timeout` (0) hoặc
 * có mà ≥ deadline thì một câu chậm hợp lệ bị client bỏ, backend vẫn chạy và giữ lock, lần thử lại dồn backend mồ côi
 * tới `max_connections`. Trả mô tả vi phạm, hoặc `undefined`.
 */
export function statementTimeoutProblem(
  role: string,
  settingMs: number,
  deadline: { key: string; ms: number },
): string | undefined {
  if (!Number.isInteger(settingMs) || settingMs < 0)
    return `${role} statement_timeout could not be read from pg_settings`;
  if (settingMs === 0)
    return `${role} statement_timeout is 0 (unset): set it on the role, below ${deadline.key}`;
  return settingMs >= deadline.ms
    ? `${role} statement_timeout (${settingMs} ms) must be below ${deadline.key} (${deadline.ms} ms)`
    : undefined;
}

/**
 * Báo vi phạm `statementTimeoutProblem` (dùng chung giữa readiness `database` và `auth_database`). Production: log error
 * mỗi lần rồi ném (probe down) — kiểm ở mỗi probe chứ không chỉ lúc boot, vì role có thể bị sửa sau đó. Ngoài production
 * chỉ log error một lần cho mỗi reporter (mỗi process): test/dev cố ý dùng deadline ngắn hơn `statement_timeout` của DB
 * dùng chung, và probe hỏng thì mọi 500 mơ hồ thành 503.
 */
export class StatementTimeoutReporter {
  private reported = false;
  private readonly enforced: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly event: string,
    nodeEnv: string,
  ) {
    this.enforced = nodeEnv === PRODUCTION;
  }

  /** `fields`: trường log thêm (không PII); `problem` `undefined` thì không làm gì. */
  report(
    problem: string | undefined,
    fields: Record<string, unknown> = {},
  ): void {
    if (problem === undefined) return;
    if (!this.enforced && this.reported) return;
    this.reported = true;
    this.logger.error(
      { event: this.event, ...fields, enforced: this.enforced },
      problem,
    );
    if (this.enforced) throw new Error(problem);
  }
}

type Session = {
  role: string;
  em: EntityManager;
  deadline: { key: string; ms: number };
};

/**
 * Final review M1: một câu probe trên client RIÊNG (cùng cấu hình kết nối với pool: host, role, TLS), không mượn slot của
 * pool. Lý do không dùng `Db`/`RelayDb` hay `pool.connect()`: `withTimeout` của terminus chỉ trả `down`, không huỷ được
 * query, nên probe bị bỏ rơi vẫn chờ slot (tới `DB_WORKER_CONNECTION_TIMEOUT_MS`) rồi giữ slot (tới query deadline) — pool
 * relay chỉ có 2 slot; và pg-pool tính cả connection ĐANG MỞ vào `max`, nên ngay cả `pool.connect()` có hạn riêng vẫn
 * chiếm slot khi pool nguội gặp mạng blackhole. Ở đây cả kết nối lẫn query có hạn `timeoutMs` do chính pg áp
 * (`connectionTimeoutMillis` huỷ socket, `query_timeout`), và `end()` huỷ socket khi query còn treo (client.js:804-806),
 * nên probe trả kết quả trong tối đa 2 × `timeoutMs` và không bao giờ giữ tài nguyên của pool.
 */
async function probeQuery<R extends pg.QueryResultRow>(
  em: EntityManager,
  sql: string,
  timeoutMs: number,
): Promise<R[]> {
  const pool = await em.getConnection().getNativeClient();
  const client = new pg.Client({
    ...pool.options,
    // pg-pool giữ `password` là thuộc tính KHÔNG enumerable của `options` (không lộ khi log), nên spread bỏ mất nó.
    password: pool.options.password,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // Client không có listener 'error' thì socket chết lúc rảnh là uncaught exception; lỗi đó vẫn làm probe thất bại.
  let connectionError: Error | undefined;
  client.on('error', (err) => {
    connectionError = err;
  });
  try {
    await client.connect();
    const { rows } = await client.query<R>(sql);
    if (connectionError) throw connectionError;
    return rows;
  } finally {
    // Không chờ: `end()` chỉ resolve ở 'end' của socket; client riêng, không giữ gì của pool.
    void client.end();
  }
}

/**
 * S2-R70 I3 (cùng mẫu S2-R60 M4 của pool auth): readiness `database` đọc `statement_timeout` thật thay cho `SELECT 1`
 * (cùng một round trip) trên mỗi pool core có deadline phía client, và so với deadline của vai trò process:
 * - api: `app_user` ↔ `DB_QUERY_TIMEOUT_MS`;
 * - worker: `app_relay` (connection relay, nếu có) và `app_user` ↔ `DB_WORKER_QUERY_TIMEOUT_MS` (`SET LOCAL` của job đã
 *   bị luật `database-worker-query-deadline` chặn dưới deadline).
 * Production: vi phạm làm readiness `database` down (log error mỗi lần) — kiểm ở mỗi probe chứ không chỉ lúc boot, vì
 * role có thể bị sửa sau đó. Ngoài production chỉ log error một lần mỗi process: test/dev cố ý dùng deadline ngắn.
 * Final review M1: mỗi câu probe có hạn `HEALTH_CHECK_TIMEOUT_MS` và không dùng slot của pool (`probeQuery`).
 */
@Injectable()
export class DbStatementTimeoutCheck {
  private readonly reporter: StatementTimeoutReporter;

  constructor(
    @InjectEntityManager(DB_CONTEXT.app) private readonly appEm: EntityManager,
    @Inject(databaseConfig.KEY)
    private readonly cfg: ConfigOf<typeof databaseConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
    @Optional()
    @InjectEntityManager(DB_CONTEXT.relay)
    private readonly relayEm?: EntityManager,
  ) {
    this.reporter = new StatementTimeoutReporter(
      new Logger(DbStatementTimeoutCheck.name),
      'db_statement_timeout_misconfigured',
      app.nodeEnv,
    );
  }

  /**
   * Chạy trên mọi pool core liên quan, mỗi câu trong hạn `timeoutMs` (`HEALTH_CHECK_TIMEOUT_MS` của readiness); ném khi DB
   * lỗi hoặc quá hạn, hoặc khi vi phạm ở production.
   */
  async run(timeoutMs: number): Promise<void> {
    for (const s of this.sessions()) {
      const rows = await probeQuery<{ setting: string }>(
        s.em,
        STATEMENT_TIMEOUT_SQL,
        timeoutMs,
      );
      this.reporter.report(
        statementTimeoutProblem(s.role, Number(rows[0]?.setting), s.deadline),
      );
    }
  }

  private sessions(): Session[] {
    const app = (deadline: Session['deadline']): Session => ({
      role: this.cfg.appUser,
      em: this.appEm,
      deadline,
    });
    switch (this.app.role) {
      case 'api':
        return [
          app({ key: 'DB_QUERY_TIMEOUT_MS', ms: this.cfg.queryTimeoutMs }),
        ];
      case 'worker':
      case 'migrate': {
        const deadline = {
          key: 'DB_WORKER_QUERY_TIMEOUT_MS',
          ms: this.cfg.workerQueryTimeoutMs,
        };
        const relay = this.relayEm;
        return [
          app(deadline),
          ...(relay ? [{ role: this.cfg.relayUser, em: relay, deadline }] : []),
        ];
      }
      default: {
        const unknown: never = this.app.role;
        throw new Error(`Unknown APP_ROLE "${String(unknown)}"`);
      }
    }
  }
}
