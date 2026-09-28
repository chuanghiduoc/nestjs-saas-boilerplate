import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';
import { databaseConfig } from '../../../../src/core/database/database.config.js';
import { dbErrorMapper } from '../../../../src/core/database/db-error.mapper.js';
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

describe('dbErrorMapper: client-side deadlines are infrastructure errors (S2-R67)', () => {
  const wrapped = (message: string) =>
    new Error('driver wrapper', { cause: new Error(message) });

  it.each([
    'Query read timeout',
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
    'Connection terminated',
    'Client was closed and is not queryable',
  ])('"%s" → 503 service_unavailable, directly and as a cause', (message) => {
    for (const err of [new Error(message), wrapped(message)])
      expect(dbErrorMapper(err)?.error).toMatchObject({
        code: 'service_unavailable',
        status: 503,
      });
  });

  it('does not match look-alike messages (exact message, not substring)', () => {
    expect(dbErrorMapper(new Error('Query read timeout in my code'))).toBe(
      undefined,
    );
  });
});
