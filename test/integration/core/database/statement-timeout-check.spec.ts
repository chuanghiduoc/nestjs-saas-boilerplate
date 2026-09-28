import { Logger, type INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConfigOf, appConfig } from '../../../../src/core/config/index.js';
import {
  DatabaseModule,
  Db,
  DbStatementTimeoutCheck,
  RelayDb,
  databaseConfig,
} from '../../../../src/core/database/index.js';
import { HealthModule, Readiness } from '../../../../src/core/health/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

/** `statement_timeout` của role trên DB test (`TEST_DB_TIMEOUTS` của `infra.global-setup.ts`). */
const APP_USER_STATEMENT_TIMEOUT_MS = 5000;
const APP_RELAY_STATEMENT_TIMEOUT_MS = 60_000;
/** Luật cấu hình worker: `DB_WORKER_STATEMENT_TIMEOUT_MS` < deadline worker; giá trị nhỏ để đặt deadline tuỳ ý. */
const WORKER_JOB_STATEMENT_TIMEOUT_MS = 1000;

/**
 * S2-R70 I3 (mẫu S2-R60 M4): readiness `database` đọc `statement_timeout` THẬT của role qua pool core và đòi nó nhỏ hơn
 * deadline phía client của vai trò process. Production: vi phạm làm check thất bại (log error mỗi lần). Ngoài
 * production: log error một lần, check vẫn qua.
 */
describe('core readiness checks the real role statement_timeout against the client deadline (S2-R70 I3)', () => {
  let app: INestApplication | undefined;
  const spyError = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  let errors: ReturnType<typeof spyError> | undefined;

  /**
   * App dựng ngoài production (luật production khác — TLS DB/Redis — không đạt trên hạ tầng test), rồi check được dựng
   * lại với `nodeEnv` của môi trường cần thử; Db/RelayDb là của app thật.
   */
  const checkWith = async (
    env: Record<string, string>,
    opts: { relay?: boolean; production?: boolean } = {},
  ): Promise<DbStatementTimeoutCheck> => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    errors = spyError();
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: opts.relay === true }),
    ]);
    const cfg = app.get<ConfigOf<typeof appConfig>>(appConfig.KEY);
    return new DbStatementTimeoutCheck(
      app.get(Db),
      app.get<ConfigOf<typeof databaseConfig>>(databaseConfig.KEY),
      { ...cfg, nodeEnv: opts.production ? 'production' : cfg.nodeEnv },
      opts.relay ? app.get(RelayDb) : undefined,
    );
  };
  const misconfigLogs = () =>
    (errors?.mock.calls ?? []).flatMap(([fields, message]) =>
      typeof fields === 'object' &&
      fields !== null &&
      'event' in fields &&
      fields.event === 'db_statement_timeout_misconfigured'
        ? [{ fields, message }]
        : [],
    );

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    app = undefined;
  });

  it('api, production: passes with the defaults (app_user 5000 ms < DB_QUERY_TIMEOUT_MS 6000 ms)', async () => {
    const check = await checkWith({ APP_ROLE: 'api' }, { production: true });
    await expect(check.run()).resolves.toBeUndefined();
    expect(misconfigLogs()).toEqual([]);
  });

  it('api, production: DB_QUERY_TIMEOUT_MS at the role value fails every check loudly', async () => {
    const check = await checkWith(
      {
        APP_ROLE: 'api',
        DB_QUERY_TIMEOUT_MS: String(APP_USER_STATEMENT_TIMEOUT_MS),
      },
      { production: true },
    );
    const message = `app_user statement_timeout (${APP_USER_STATEMENT_TIMEOUT_MS} ms) must be below DB_QUERY_TIMEOUT_MS (${APP_USER_STATEMENT_TIMEOUT_MS} ms)`;
    await expect(check.run()).rejects.toThrow(message);
    await expect(check.run()).rejects.toThrow(message);
    expect(misconfigLogs()).toHaveLength(2);
  });

  it('worker, production: the relay connection (app_relay 60000 ms) is checked against DB_WORKER_QUERY_TIMEOUT_MS', async () => {
    const env = {
      APP_ROLE: 'worker',
      DB_WORKER_STATEMENT_TIMEOUT_MS: String(WORKER_JOB_STATEMENT_TIMEOUT_MS),
      DB_WORKER_QUERY_TIMEOUT_MS: String(APP_RELAY_STATEMENT_TIMEOUT_MS),
      DB_WORKER_CONNECTION_TIMEOUT_MS: String(APP_RELAY_STATEMENT_TIMEOUT_MS),
    };
    const check = await checkWith(env, { relay: true, production: true });
    await expect(check.run()).rejects.toThrow(
      `app_relay statement_timeout (${APP_RELAY_STATEMENT_TIMEOUT_MS} ms) must be below DB_WORKER_QUERY_TIMEOUT_MS (${APP_RELAY_STATEMENT_TIMEOUT_MS} ms)`,
    );
  });

  it('worker, production: passes with the defaults (app_relay 60000 ms < DB_WORKER_QUERY_TIMEOUT_MS 65000 ms)', async () => {
    const check = await checkWith(
      { APP_ROLE: 'worker' },
      { relay: true, production: true },
    );
    await expect(check.run()).resolves.toBeUndefined();
  });

  it('outside production: the misconfiguration is logged once per process and the check still passes', async () => {
    const check = await checkWith({
      APP_ROLE: 'api',
      DB_QUERY_TIMEOUT_MS: '1000',
    });
    await expect(check.run()).resolves.toBeUndefined();
    await expect(check.run()).resolves.toBeUndefined();
    expect(misconfigLogs()).toEqual([
      {
        fields: {
          event: 'db_statement_timeout_misconfigured',
          enforced: false,
        },
        message: `app_user statement_timeout (${APP_USER_STATEMENT_TIMEOUT_MS} ms) must be below DB_QUERY_TIMEOUT_MS (1000 ms)`,
      },
    ]);
  });

  it('is wired into readiness: the database indicator runs the check, and its failure takes readiness down', async () => {
    vi.stubEnv('APP_ROLE', 'api');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      HealthModule.forRoot({ http: true }),
    ]);
    const run = vi.spyOn(DbStatementTimeoutCheck.prototype, 'run');
    const [database] = app.get(Readiness).indicators();
    if (!database) throw new Error('database indicator missing');
    await expect(database()).resolves.toMatchObject({
      database: { status: 'up' },
    });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValueOnce(new Error('statement_timeout misconfigured'));
    await expect(database()).resolves.toMatchObject({
      database: { status: 'down' },
    });
  });
});
