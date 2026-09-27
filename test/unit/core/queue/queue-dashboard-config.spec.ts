import { describe, expect, it } from 'vitest';
import { queueDashboardConfig } from '../../../../src/core/queue/dashboard/queue-dashboard.config.js';

describe('queueDashboardConfig', () => {
  it('defaults: disabled, loopback only, empty allowlist', () => {
    expect(queueDashboardConfig.schema.parse({})).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3002,
      basePath: '/queues',
      ipAllowlist: [],
    });
  });
  it('accepts IPs and CIDRs, rejects garbage', () => {
    expect(
      queueDashboardConfig.schema.parse({
        ipAllowlist: '10.0.0.0/8, 127.0.0.1',
      }).ipAllowlist,
    ).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(
      queueDashboardConfig.schema.safeParse({ ipAllowlist: 'not-an-ip' })
        .success,
    ).toBe(false);
  });
});
