import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  isPublicAddress,
  parseCidrs,
} from '../../../../src/core/resilience/index.js';

/** Unit test cho phép cả http để phủ nhánh IP literal/port; nhánh https-only có test riêng. */
const cfg = {
  allowedSchemes: ['http', 'https'],
  allowedPorts: [80, 443],
  allowCidrs: [],
};

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '198.18.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001::1',
    'not-an-ip',
  ])('denies %s', (ip) => {
    expect(isPublicAddress(ip, [])).toBe(false);
  });
  it('allows public unicast addresses', () => {
    expect(isPublicAddress('93.184.216.34', [])).toBe(true);
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946', [])).toBe(
      true,
    );
    expect(isPublicAddress('::ffff:93.184.216.34', [])).toBe(true);
  });
  it('allowlisted CIDRs are exempt, for the right family only', () => {
    const allow = parseCidrs(['10.0.0.0/8', 'fd00::/8']);
    expect(isPublicAddress('10.9.9.9', allow)).toBe(true);
    expect(isPublicAddress('::ffff:10.9.9.9', allow)).toBe(true);
    expect(isPublicAddress('fd00::5', allow)).toBe(true);
    expect(isPublicAddress('192.168.0.1', allow)).toBe(false);
  });
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://100.64.0.1/',
  ])('rejects literal/encoded internal host %s before connecting', (url) => {
    expect(() => assertUrlAllowed(new URL(url), cfg)).toThrow(/not allowed/);
  });
  it('rejects non-http schemes and ports outside the allowlist', () => {
    expect(() => assertUrlAllowed(new URL('file:///etc/passwd'), cfg)).toThrow(
      /scheme/,
    );
    expect(() =>
      assertUrlAllowed(new URL('http://example.com:6379/'), cfg),
    ).toThrow(/port/);
    expect(() =>
      assertUrlAllowed(new URL('http://example.com:443/'), cfg),
    ).not.toThrow();
  });
  it('https-only config rejects plain http', () => {
    const httpsOnly = { ...cfg, allowedSchemes: ['https'] };
    expect(() =>
      assertUrlAllowed(new URL('http://example.com/'), httpsOnly),
    ).toThrow(/scheme/);
    expect(() =>
      assertUrlAllowed(new URL('https://example.com/'), httpsOnly),
    ).not.toThrow();
  });
  it('rejects credentials embedded in the URL', () => {
    expect(() =>
      assertUrlAllowed(new URL('https://user:pass@example.com/'), cfg),
    ).toThrow(/credentials/);
    expect(() =>
      assertUrlAllowed(new URL('https://user@example.com/'), cfg),
    ).toThrow(/credentials/);
  });
});
