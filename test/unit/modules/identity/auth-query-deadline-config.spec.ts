import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';
import { authDatabaseConfig } from '../../../../src/modules/identity/identity.config.js';

const RULE = 'identity-auth-query-deadline';
const rule = () => {
  const found = productionRuleRegistry().find((r) => r.name === RULE);
  if (!found) throw new Error(`Missing production rule ${RULE}`);
  return found.rule;
};
const cfg = (
  auth: { connectionTimeoutMs?: number; queryTimeoutMs?: number },
  checkTimeoutMs = 500,
  mode = 'local',
  requestBudgetMs = 30_000,
  enumerationMinResponseMs = 300,
) => ({
  identity: { mode },
  identityGuard: { enumerationMinResponseMs },
  authDatabase: { connectionTimeoutMs: 3000, queryTimeoutMs: 6000, ...auth },
  health: { checkTimeoutMs },
  http: { requestBudgetMs },
});

describe('DB_AUTH_QUERY_TIMEOUT_MS (S2-R60)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 6000 ms, above the compose auth_user statement_timeout default (5000 ms)', () => {
    expect(authDatabaseConfig().queryTimeoutMs).toBe(6000);
  });

  it.each(['0', '-1', 'abc'])('rejects %s', (value) => {
    vi.stubEnv('DB_AUTH_QUERY_TIMEOUT_MS', value);
    expect(() => validateAllConfigs()).toThrow(/DB_AUTH_QUERY_TIMEOUT_MS/);
  });

  it('production: the worst auth request path must fit below HTTP_REQUEST_BUDGET_MS (default 30000 ms)', () => {
    // Mặc định: 2 x (3000 + 6000) + 500 = 18500.
    expect(rule()(cfg({}))).toBeUndefined();
    // Biên: 2 x (3000 + 11749) + 500 = 29998 < 30000; 2 x (3000 + 11750) + 500 = 30000 thì không còn "dưới". Mức sàn 300
    // không cộng thêm (29998 + 300 đã vượt): response tới lúc max(đường DB, mức sàn).
    expect(rule()(cfg({ queryTimeoutMs: 11_749 }))).toBeUndefined();
    expect(rule()(cfg({ queryTimeoutMs: 11_750 }))).toMatch(
      /\(30000\) must be below HTTP_REQUEST_BUDGET_MS \(30000 ms\)/,
    );
    expect(rule()(cfg({ connectionTimeoutMs: 10_000 }, 500))).toMatch(
      /DB_AUTH_QUERY_TIMEOUT_MS/,
    );
    expect(rule()(cfg({}, 20_000))).toMatch(/HEALTH_CHECK_TIMEOUT_MS/);
    // S2-R67: ngân sách đọc từ config `http`, không phải hằng số.
    expect(
      rule()(cfg({ queryTimeoutMs: 11_750 }, 500, 'local', 60_000)),
    ).toBeUndefined();
  });

  it('production (review M5): the S2-R58 floor counts as max(DB path, floor), so a floor at or above the budget fails on its own', () => {
    expect(rule()(cfg({}, 500, 'local', 30_000, 29_999))).toBeUndefined();
    expect(rule()(cfg({}, 500, 'local', 30_000, 30_000))).toMatch(
      /AUTH_ENUMERATION_MIN_RESPONSE_MS\) \(30000\) must be below HTTP_REQUEST_BUDGET_MS \(30000 ms\)/,
    );
  });

  it('production: external mode has no auth_user pool, so the rule does not apply', () => {
    expect(
      rule()(cfg({ queryTimeoutMs: 60_000 }, 500, 'external')),
    ).toBeUndefined();
  });

  it('production: fails loudly when a namespace the rule reads is missing', () => {
    expect(rule()({ identity: { mode: 'local' } })).toMatch(
      /needs the authDatabase, health, http and identityGuard config namespaces/,
    );
  });
});
