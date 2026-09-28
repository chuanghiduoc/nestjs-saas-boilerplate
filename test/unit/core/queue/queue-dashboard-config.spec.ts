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

  // S2-R31 (I1): a malformed CIDR must fail loudly at config load, by index, never by falling back
  // to an accidental /0 (the bug this fix closes: `'10.0.0.0/'.split('/')` used to yield
  // `prefix=''`, `Number('')` is `0`, so the entry passed as a valid /0 and admitted every IP).
  describe('rejects malformed entries loudly, by index (not by value)', () => {
    it.each([
      ['empty prefix', '10.0.0.0/'],
      ['IPv6 zone id', 'fe80::1%eth0'],
      ['IPv6 zone id with prefix', 'fe80::1%eth0/64'],
      ['non-numeric prefix', '10.0.0.0/abc'],
      ['extra slash', '10.0.0.0/8/16'],
      ['whitespace inside the prefix', '10.0.0.0/ 8'],
    ])('%s ("%s")', (_label, entry) => {
      const result = queueDashboardConfig.schema.safeParse({
        ipAllowlist: entry,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const [issue] = result.error.issues;
        expect(issue?.message).toMatch(/index 0/);
        // The offending value itself must not appear in the message.
        expect(issue?.message).not.toContain(entry);
      }
    });

    it('reports the correct index when a later entry in the list is the offender', () => {
      const result = queueDashboardConfig.schema.safeParse({
        ipAllowlist: '127.0.0.1, 10.0.0.0/',
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0]?.message).toMatch(/index 1/);
    });
  });

  it.each([
    ['IPv4', '0.0.0.0/0'],
    ['IPv6', '::/0'],
  ])(
    'rejects /0 in every environment (%s: a dashboard open to every address defeats the allowlist)',
    (_family, entry) => {
      expect(
        queueDashboardConfig.schema.safeParse({ ipAllowlist: entry }).success,
      ).toBe(false);
    },
  );

  it('a typo that used to become an accidental allow-all never parses, so 8.8.8.8 is never admitted', () => {
    // Before the fix, this exact typo ('10.0.0.0/' with the trailing slash but no digits) was
    // accepted by the schema and built a BlockList subnet of /0, which matches 8.8.8.8 too.
    const result = queueDashboardConfig.schema.safeParse({
      ipAllowlist: '10.0.0.0/',
    });
    expect(result.success).toBe(false);
  });
});
