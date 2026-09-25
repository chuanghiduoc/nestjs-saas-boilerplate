import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { resilienceConfig } from '../../../../src/core/resilience/index.js';

describe('resilienceConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to https only, ports 80/443, no allowlisted CIDRs, empty overrides', () => {
    const r = resilienceConfig();
    expect(r.allowedSchemes).toEqual(['https']);
    expect(r.allowedPorts).toEqual([80, 443]);
    expect(r.allowCidrs).toEqual([]);
    expect(r.overrides).toEqual({});
  });
  it.each([
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '10.0.0.0/33'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', 'localhost'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '0.0.0.0/0'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '::/0'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '10.0.0.1/0'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '169.254.0.0/16'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '169.254.169.254/32'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '128.0.0.0/1'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', 'fd00:ec2::/32'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', 'fc00::/7'],
    ['RESILIENCE_SSRF_ALLOW_CIDRS', '::ffff:10.0.0.0/104'],
    ['RESILIENCE_ALLOWED_SCHEMES', 'https,ftp'],
    ['RESILIENCE_ALLOWED_PORTS', '0'],
    ['RESILIENCE_OVERRIDES', '{"p":{"retries":-1}}'],
    ['RESILIENCE_OVERRIDES', '{"p":{"nope":1}}'],
    ['RESILIENCE_OVERRIDES', '{not json'],
  ])('rejects %s=%s', (name, value) => {
    vi.stubEnv(name, value);
    expect(() => resilienceConfig()).toThrow(name);
  });
  it('production rule allows https only', () => {
    const rule = productionRuleRegistry().find(
      (r) => r.name === 'resilience-https-only',
    );
    expect(rule?.rule({ resilience: { allowedSchemes: ['https'] } })).toBe(
      undefined,
    );
    expect(
      rule?.rule({ resilience: { allowedSchemes: ['http', 'https'] } }),
    ).toMatch(/https only/);
  });
  it('parses per-provider overrides', () => {
    vi.stubEnv(
      'RESILIENCE_OVERRIDES',
      '{"sepay":{"retries":0,"timeoutMs":5000}}',
    );
    expect(resilienceConfig().overrides).toEqual({
      sepay: { retries: 0, timeoutMs: 5000 },
    });
  });
});
