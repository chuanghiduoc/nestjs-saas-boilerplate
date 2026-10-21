import { describe, expect, it } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import {
  configRuleRegistry,
  productionRuleRegistry,
  type ConfigRule,
} from '../../../../src/core/config/config.registry.js';

const ruleOf = (list: readonly ConfigRule[], name: string) => {
  const found = list.find((r) => r.name === name);
  if (!found) throw new Error(`Missing rule ${name}`);
  return found.rule;
};
const TIMEOUTS = { connectionTimeoutMs: 3000, queryTimeoutMs: 6000 };

describe('role-aware database rules (spec SP7 §6.5, C3)', () => {
  it('DB_APP_PASSWORD is required on api and worker, never on migrate', () => {
    const r = ruleOf(configRuleRegistry(), 'database-app-password-required');
    for (const role of ['api', 'worker'])
      expect(r({ app: { role }, database: {} })).toBe(
        'DB_APP_PASSWORD is required on api and worker',
      );
    expect(r({ app: { role: 'migrate' }, database: {} })).toBeUndefined();
    expect(
      r({ app: { role: 'api' }, database: { appPassword: 'p' } }),
    ).toBeUndefined();
  });
  it('the production query deadline rule skips migrate (no http namespace there) and still needs http on api/worker', () => {
    const r = ruleOf(productionRuleRegistry(), 'database-query-deadline');
    expect(r({ app: { role: 'migrate' }, database: TIMEOUTS })).toBeUndefined();
    expect(r({ app: { role: 'worker' }, database: TIMEOUTS })).toMatch(
      /needs the database and http config namespaces/,
    );
  });
});
