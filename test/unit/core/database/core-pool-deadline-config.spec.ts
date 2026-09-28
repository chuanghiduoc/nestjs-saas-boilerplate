import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import pg from 'pg';
import {
  configRuleRegistry,
  productionRuleRegistry,
} from '../../../../src/core/config/config.registry.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';
import { databaseConfig } from '../../../../src/core/database/database.config.js';
import { DriverException } from '@mikro-orm/core';
import { dbErrorMapper } from '../../../../src/core/database/db-error.mapper.js';
import {
  isDbInfraError,
  isDbNoAnswerError,
} from '../../../../src/core/database/db-infra-error.js';
import { clientDestroyReason } from '../../../../src/core/database/pool-checkouts.js';
import { statementTimeoutProblem } from '../../../../src/core/database/statement-timeout-check.js';
import { httpConfig } from '../../../../src/core/http/http.config.js';

const RULE = 'database-query-deadline';
const rule = () => {
  const found = productionRuleRegistry().find((r) => r.name === RULE);
  if (!found) throw new Error(`Missing production rule ${RULE}`);
  return found.rule;
};
const cfg = (
  db: { connectionTimeoutMs?: number; queryTimeoutMs?: number },
  requestBudgetMs = 30_000,
) => ({
  database: { connectionTimeoutMs: 3000, queryTimeoutMs: 6000, ...db },
  http: { requestBudgetMs },
});

describe('core pool client-side deadlines (S2-R67)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults: connect 3000 ms, query 6000 ms (above the compose app_user statement_timeout default 5000 ms), HTTP budget 30000 ms', () => {
    vi.stubEnv('DB_HOST', 'db.test');
    vi.stubEnv('DB_NAME', 'app');
    vi.stubEnv('DB_APP_PASSWORD', 'secret');
    expect(databaseConfig()).toMatchObject({
      connectionTimeoutMs: 3000,
      queryTimeoutMs: 6000,
    });
    expect(httpConfig().requestBudgetMs).toBe(30_000);
  });

  it.each([
    ['DB_CONNECTION_TIMEOUT_MS', '0'],
    ['DB_CONNECTION_TIMEOUT_MS', 'abc'],
    ['DB_QUERY_TIMEOUT_MS', '0'],
    ['DB_QUERY_TIMEOUT_MS', '-1'],
    ['HTTP_REQUEST_BUDGET_MS', '0'],
    ['HTTP_REQUEST_BUDGET_MS', '1.5'],
  ])('rejects %s=%s', (key, value) => {
    vi.stubEnv(key, value);
    expect(() => validateAllConfigs()).toThrow(new RegExp(key));
  });

  it('production: connect + query + ROLLBACK deadline must fit below HTTP_REQUEST_BUDGET_MS', () => {
    // Mặc định: 3000 + 2 x 6000 = 15000.
    expect(rule()(cfg({}))).toBeUndefined();
    // Biên: 3000 + 2 x 13499 = 29998 < 30000; 3000 + 2 x 13500 = 30000 thì không còn "dưới".
    expect(rule()(cfg({ queryTimeoutMs: 13_499 }))).toBeUndefined();
    expect(rule()(cfg({ queryTimeoutMs: 13_500 }))).toMatch(
      /\(30000\) must be below HTTP_REQUEST_BUDGET_MS \(30000 ms\)/,
    );
    expect(rule()(cfg({ connectionTimeoutMs: 20_000 }))).toMatch(
      /DB_CONNECTION_TIMEOUT_MS \+ 2 x DB_QUERY_TIMEOUT_MS/,
    );
    // Ngân sách lấy từ config, không phải hằng số: nới ngân sách thì cùng deadline đó hợp lệ.
    expect(rule()(cfg({ queryTimeoutMs: 13_500 }, 60_000))).toBeUndefined();
    expect(rule()(cfg({}, 15_000))).toMatch(/HTTP_REQUEST_BUDGET_MS/);
  });

  it('production: fails loudly when a namespace the rule reads is missing', () => {
    expect(
      rule()({ database: { connectionTimeoutMs: 1, queryTimeoutMs: 1 } }),
    ).toMatch(/needs the database and http config namespaces/);
    expect(rule()({ http: { requestBudgetMs: 30_000 } })).toMatch(
      /needs the database and http config namespaces/,
    );
  });

  it('the auth pool rule reads the same HTTP_REQUEST_BUDGET_MS (no hard-coded budget)', async () => {
    await import('../../../../src/modules/identity/identity.config.js');
    const auth = productionRuleRegistry().find(
      (r) => r.name === 'identity-auth-query-deadline',
    );
    if (!auth) throw new Error('Missing production rule');
    const c = (requestBudgetMs: number) => ({
      identity: { mode: 'local' },
      // S2-R60 review M5: the auth rule also reads the S2-R58 floor (max with the DB path).
      identityGuard: { enumerationMinResponseMs: 300 },
      authDatabase: { connectionTimeoutMs: 3000, queryTimeoutMs: 6000 },
      health: { checkTimeoutMs: 500 },
      http: { requestBudgetMs },
    });
    // 2 x (3000 + 6000) + 500 = 18500.
    expect(auth.rule(c(18_501))).toBeUndefined();
    expect(auth.rule(c(18_500))).toMatch(
      /\(18500\) must be below HTTP_REQUEST_BUDGET_MS \(18500 ms\)/,
    );
  });
});

describe('isDbInfraError / dbErrorMapper: DB infrastructure errors are 503 (S2-R67, S2-R70 I2)', () => {
  const plain = (message: string, code?: string) =>
    Object.assign(new Error(message), code ? { code } : {});
  const driver = (inner: Error) => new DriverException(inner);

  it.each([
    ['pg deadline', plain('Query read timeout')],
    ['pool wait', plain('timeout exceeded when trying to connect')],
    [
      'connect timeout (pg-pool wraps the cause)',
      new Error('Connection terminated due to connection timeout', {
        cause: plain('Connection terminated unexpectedly'),
      }),
    ],
    ['socket drop', plain('Connection terminated unexpectedly')],
    ['closing client', plain('Connection terminated')],
    [
      'query on a dead client',
      plain('Client has encountered a connection error and is not queryable'),
    ],
    [
      'query on a closed client',
      plain('Client was closed and is not queryable'),
    ],
    [
      'ECONNREFUSED',
      plain('connect ECONNREFUSED 10.0.0.1:5432', 'ECONNREFUSED'),
    ],
    ['ECONNRESET', plain('read ECONNRESET', 'ECONNRESET')],
    ['EPIPE', plain('write EPIPE', 'EPIPE')],
    ['ETIMEDOUT', plain('connect ETIMEDOUT', 'ETIMEDOUT')],
    ['08006 connection_failure', plain('connection failure', '08006')],
    ['53300 too_many_connections', plain('sorry, too many clients', '53300')],
    ['57P01 admin_shutdown', plain('terminating connection', '57P01')],
    [
      '57P03 cannot_connect_now',
      plain('the database system is starting up', '57P03'),
    ],
    ['57014 query_canceled', plain('canceling statement', '57014')],
  ])(
    '%s → 503 service_unavailable, raw and wrapped by MikroORM',
    (_name, err) => {
      for (const e of [err, driver(err)]) {
        expect(isDbInfraError(e)).toBe(true);
        expect(dbErrorMapper(e)?.error).toMatchObject({
          code: 'service_unavailable',
          status: 503,
        });
      }
    },
  );

  it('server-answered infra SQLSTATEs are not "no answer"; connection loss and deadlines are', () => {
    expect(isDbNoAnswerError(plain('terminating connection', '57P01'))).toBe(
      false,
    );
    expect(isDbNoAnswerError(plain('canceling statement', '57014'))).toBe(
      false,
    );
    expect(isDbNoAnswerError(plain('Query read timeout'))).toBe(true);
    expect(isDbNoAnswerError(plain('read ECONNRESET', 'ECONNRESET'))).toBe(
      true,
    );
  });

  it('ignores errors that are not DB-shaped (another library with the same socket code or message)', () => {
    const undici = Object.assign(new TypeError('fetch failed'), {
      cause: plain('connect ECONNREFUSED 10.0.0.1:443', 'ECONNREFUSED'),
    });
    class RedisError extends Error {}
    expect(isDbInfraError(undici)).toBe(false);
    expect(isDbInfraError(new RedisError('Connection terminated'))).toBe(false);
    expect(dbErrorMapper(undici)).toBeUndefined();
    expect(isDbInfraError(plain('duplicate key', '23505'))).toBe(false);
    expect(isDbInfraError('Query read timeout')).toBe(false);
  });
});

describe('worker deadlines (S2-R70 item 7)', () => {
  const crossRule = (name: string) => {
    const found = configRuleRegistry().find((r) => r.name === name);
    if (!found) throw new Error(`Missing config rule ${name}`);
    return found.rule;
  };
  const db = (d: Record<string, number>) => ({
    database: {
      workerStatementTimeoutMs: 60_000,
      workerQueryTimeoutMs: 65_000,
      workerConnectionTimeoutMs: 65_000,
      ...d,
    },
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defaults: worker query and connection deadlines 65000 ms, above the 60000 ms job statement_timeout', () => {
    vi.stubEnv('DB_HOST', 'db.test');
    vi.stubEnv('DB_NAME', 'app');
    vi.stubEnv('DB_APP_PASSWORD', 'secret');
    expect(databaseConfig()).toMatchObject({
      workerQueryTimeoutMs: 65_000,
      workerConnectionTimeoutMs: 65_000,
      workerStatementTimeoutMs: 60_000,
    });
    expect(crossRule('database-worker-query-deadline')(db({}))).toBeUndefined();
    expect(
      crossRule('database-worker-connection-wait')(db({})),
    ).toBeUndefined();
  });

  it('the worker query deadline must be above DB_WORKER_STATEMENT_TIMEOUT_MS (strict)', () => {
    const rule = crossRule('database-worker-query-deadline');
    expect(rule(db({ workerQueryTimeoutMs: 60_001 }))).toBeUndefined();
    expect(rule(db({ workerQueryTimeoutMs: 60_000 }))).toMatch(
      /DB_WORKER_QUERY_TIMEOUT_MS \(60000\) must be above DB_WORKER_STATEMENT_TIMEOUT_MS \(60000\)/,
    );
    expect(rule({})).toMatch(/needs the database config namespace/);
  });

  it('the worker slot wait must be at least the worker query deadline', () => {
    const rule = crossRule('database-worker-connection-wait');
    expect(rule(db({ workerConnectionTimeoutMs: 65_000 }))).toBeUndefined();
    expect(rule(db({ workerConnectionTimeoutMs: 64_999 }))).toMatch(
      /DB_WORKER_CONNECTION_TIMEOUT_MS \(64999\) must be at least DB_WORKER_QUERY_TIMEOUT_MS \(65000\)/,
    );
  });
});

describe('statementTimeoutProblem (S2-R70 I3)', () => {
  const deadline = { key: 'DB_QUERY_TIMEOUT_MS', ms: 6000 };
  it('accepts a role statement_timeout strictly below the client deadline', () => {
    expect(statementTimeoutProblem('app_user', 5000, deadline)).toBeUndefined();
  });
  it.each([
    [0, /app_user statement_timeout is 0 \(unset\)/],
    [
      6000,
      /app_user statement_timeout \(6000 ms\) must be below DB_QUERY_TIMEOUT_MS \(6000 ms\)/,
    ],
    [Number.NaN, /could not be read/],
  ])('%s ms → problem', (ms, message) => {
    expect(statementTimeoutProblem('app_user', ms, deadline)).toMatch(message);
  });
});

describe('clientDestroyReason (S2-R70 M1)', () => {
  const client = (fields: {
    readyForQuery: boolean;
    tx?: 'I' | 'T' | 'E';
    active?: unknown;
    queue?: unknown[];
  }): pg.PoolClient =>
    Object.assign(new pg.Client(), {
      readyForQuery: fields.readyForQuery,
      _activeQuery: fields.active ?? null,
      _queryQueue: fields.queue ?? [],
      getTransactionStatus: () => fields.tx ?? 'I',
      release: () => undefined,
    });

  it('keeps an idle client, and one released after a server error before its ReadyForQuery arrived', () => {
    expect(
      clientDestroyReason(client({ readyForQuery: true })),
    ).toBeUndefined();
    expect(
      clientDestroyReason(client({ readyForQuery: false })),
    ).toBeUndefined();
  });

  it('destroys a client with a query still in flight (query deadline) or queued', () => {
    expect(
      clientDestroyReason(client({ readyForQuery: false, active: {} })),
    ).toBe('not_ready_for_query');
    expect(
      clientDestroyReason(client({ readyForQuery: false, queue: [{}] })),
    ).toBe('not_ready_for_query');
  });

  it('destroys a client released inside a transaction', () => {
    expect(clientDestroyReason(client({ readyForQuery: true, tx: 'T' }))).toBe(
      'open_transaction',
    );
    expect(clientDestroyReason(client({ readyForQuery: false, tx: 'E' }))).toBe(
      'not_ready_for_query',
    );
  });
});
