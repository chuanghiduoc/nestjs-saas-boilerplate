import { describe, expect, it } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { tenancyConfig } from '../../../../src/modules/tenancy/tenancy.config.js';

const parse = (env: Record<string, unknown>) =>
  tenancyConfig.schema.safeParse(env);
const rule = (name: string) => {
  const r = productionRuleRegistry().find((x) => x.name === name);
  if (!r) throw new Error(`production rule ${name} is not registered`);
  return r.rule;
};

describe('tenancy config (spec SP3 §13, INT-I12)', () => {
  it('defaults boot with no env at all', () => {
    expect(parse({}).data).toEqual({
      membershipMode: 'multi',
      orgCreation: 'self_service',
      maxOrgsCreatedPerUser: 5,
      orgDeleteGraceSec: 2_592_000,
      purgeCron: '0 3 * * *',
      purgeTz: 'UTC',
      purgeBatchSize: 50,
      purgeMaxBatches: 10,
      orgMissLimit: 30,
      orgMissTtlMs: 60_000,
    });
  });
  it.each([
    [{ membershipMode: 'solo' }],
    [{ orgCreation: 'anyone' }],
    [{ maxOrgsCreatedPerUser: '0' }],
    [{ maxOrgsCreatedPerUser: '1001' }],
    [{ orgDeleteGraceSec: '86399' }],
    [{ orgDeleteGraceSec: '31536001' }],
    [{ purgeCron: 'not a cron' }],
    [{ purgeTz: 'Mars/Olympus' }],
    [{ purgeBatchSize: '1001' }],
    [{ purgeMaxBatches: '0' }],
    [{ orgMissLimit: '0' }],
    [{ orgMissTtlMs: '1500' }],
  ])('rejects %j', (env) => {
    expect(parse(env).success).toBe(false);
  });
  it('production: grace must be at least 7 days', () => {
    const r = rule('tenancy-org-delete-grace');
    expect(r({ tenancy: { orgDeleteGraceSec: 604_799 } })).toMatch(
      /TENANCY_ORG_DELETE_GRACE_SEC/,
    );
    expect(r({ tenancy: { orgDeleteGraceSec: 604_800 } })).toBeUndefined();
  });
  it('production: the org-miss limiter is never looser than the default throttler (count and window)', () => {
    const r = rule('tenancy-org-miss-not-looser');
    const throttle = { limit: 300, ttlMs: 60_000 };
    expect(
      r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } }),
    ).toBeUndefined();
    expect(
      r({ throttle, tenancy: { orgMissLimit: 301, orgMissTtlMs: 60_000 } }),
    ).toMatch(/TENANCY_ORG_MISS_RATE_LIMIT/);
    expect(
      r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 10_000 } }),
    ).toMatch(/TENANCY_ORG_MISS_RATE_TTL_MS/);
    expect(r({ tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } })).toMatch(
      /needs the throttle and tenancy namespaces/,
    );
  });
});
