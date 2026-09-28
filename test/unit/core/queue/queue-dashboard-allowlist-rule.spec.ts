import { describe, expect, it } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import '../../../../src/core/queue/dashboard/queue-dashboard.config.js';

const check = (queueDashboard: { enabled: boolean; ipAllowlist: string[] }) => {
  const r = productionRuleRegistry().find(
    (x) => x.name === 'queue-dashboard-allowlist',
  );
  if (!r) throw new Error('queue-dashboard-allowlist rule not registered');
  return r.rule({ queueDashboard });
};

describe('queue-dashboard-allowlist production rule', () => {
  it('passes when disabled, regardless of the allowlist', () => {
    expect(check({ enabled: false, ipAllowlist: [] })).toBeUndefined();
  });

  it('passes when enabled with a non-empty allowlist', () => {
    expect(
      check({ enabled: true, ipAllowlist: ['127.0.0.1/32'] }),
    ).toBeUndefined();
  });

  it('rejects enabled with an empty allowlist', () => {
    expect(check({ enabled: true, ipAllowlist: [] })).toMatch(
      /QUEUE_DASHBOARD_IP_ALLOWLIST must not be empty when QUEUE_DASHBOARD_ENABLED=true in production/,
    );
  });
});
