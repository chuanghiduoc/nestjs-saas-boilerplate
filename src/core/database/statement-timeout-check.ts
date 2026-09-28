import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { databaseConfig } from './database.config.js';
import { Db } from './db.js';
import { RelayDb } from './relay-db.js';

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
  run: () => Promise<{ setting: string }[]>;
  deadline: { key: string; ms: number };
};

/**
 * S2-R70 I3 (cùng mẫu S2-R60 M4 của pool auth): readiness `database` đọc `statement_timeout` thật thay cho `SELECT 1`
 * (cùng một round trip) trên mỗi pool core có deadline phía client, và so với deadline của vai trò process:
 * - api: `app_user` ↔ `DB_QUERY_TIMEOUT_MS`;
 * - worker: `app_relay` (connection relay, nếu có) và `app_user` ↔ `DB_WORKER_QUERY_TIMEOUT_MS` (`SET LOCAL` của job đã
 *   bị luật `database-worker-query-deadline` chặn dưới deadline).
 * Production: vi phạm làm readiness `database` down (log error mỗi lần) — kiểm ở mỗi probe chứ không chỉ lúc boot, vì
 * role có thể bị sửa sau đó. Ngoài production chỉ log error một lần mỗi process: test/dev cố ý dùng deadline ngắn.
 */
@Injectable()
export class DbStatementTimeoutCheck {
  private readonly reporter: StatementTimeoutReporter;

  constructor(
    private readonly db: Db,
    @Inject(databaseConfig.KEY)
    private readonly cfg: ConfigOf<typeof databaseConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
    @Optional() private readonly relay?: RelayDb,
  ) {
    this.reporter = new StatementTimeoutReporter(
      new Logger(DbStatementTimeoutCheck.name),
      'db_statement_timeout_misconfigured',
      app.nodeEnv,
    );
  }

  /** Chạy trên mọi pool core liên quan; ném khi DB lỗi, hoặc khi vi phạm ở production. */
  async run(): Promise<void> {
    for (const s of this.sessions()) {
      const rows = await s.run();
      this.reporter.report(
        statementTimeoutProblem(s.role, Number(rows[0]?.setting), s.deadline),
      );
    }
  }

  private sessions(): Session[] {
    const app = (deadline: Session['deadline']): Session => ({
      role: this.cfg.appUser,
      run: () => this.db.execute<{ setting: string }>(STATEMENT_TIMEOUT_SQL),
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
        const relay = this.relay;
        return [
          app(deadline),
          ...(relay
            ? [
                {
                  role: this.cfg.relayUser,
                  run: () =>
                    relay.execute<{ setting: string }>(STATEMENT_TIMEOUT_SQL),
                  deadline,
                },
              ]
            : []),
        ];
      }
      default: {
        const unknown: never = this.app.role;
        throw new Error(`Unknown APP_ROLE "${String(unknown)}"`);
      }
    }
  }
}
