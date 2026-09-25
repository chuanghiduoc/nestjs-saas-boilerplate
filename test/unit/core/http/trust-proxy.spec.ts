import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateAllConfigs } from '../../../../src/core/config/index.js';
import {
  httpConfig,
  parseTrustProxy,
} from '../../../../src/core/http/index.js';

const PINNED_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.0.0';

describe('parseTrustProxy', () => {
  it('parses booleans, hop counts and address lists', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual([
      'loopback',
      '10.0.0.0/8',
    ]);
  });
});

describe('httpConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects trust proxy entries that are not presets, IPs or CIDRs', () => {
    vi.stubEnv('HTTP_TRUST_PROXY', 'loopback, not-an-ip');
    expect(() => httpConfig()).toThrow(/HTTP_TRUST_PROXY/);
    vi.stubEnv('HTTP_TRUST_PROXY', '10.0.0.0/8, ::1');
    expect(httpConfig().trustProxy).toEqual(['10.0.0.0/8', '::1']);
  });

  it('accepts only bare CORS origins', () => {
    vi.stubEnv('HTTP_CORS_ORIGINS', 'https://app.example.com/');
    expect(() => httpConfig()).toThrow(/HTTP_CORS_ORIGINS/);
    vi.stubEnv('HTTP_CORS_ORIGINS', 'https://app.example.com/path');
    expect(() => httpConfig()).toThrow(/HTTP_CORS_ORIGINS/);
    vi.stubEnv(
      'HTTP_CORS_ORIGINS',
      'https://app.example.com, http://localhost:5173',
    );
    expect(httpConfig().corsOrigins).toEqual([
      'https://app.example.com',
      'http://localhost:5173',
    ]);
  });

  it('requires an https CDN URL when docs are enabled', () => {
    vi.stubEnv('HTTP_DOCS_ENABLED', 'true');
    expect(() => httpConfig()).toThrow(/HTTP_DOCS_CDN_URL/);
    vi.stubEnv('HTTP_DOCS_CDN_URL', 'http://cdn.example.com/x.js');
    expect(() => httpConfig()).toThrow(/HTTP_DOCS_CDN_URL/);
    vi.stubEnv('HTTP_DOCS_CDN_URL', PINNED_CDN);
    expect(httpConfig().docsEnabled).toBe(true);
  });

  it('production forbids trusting every proxy hop and serving docs', () => {
    vi.stubEnv('APP_ROLE', 'api');
    vi.stubEnv('NODE_ENV', 'production');
    for (const trust of [
      'true',
      '0.0.0.0/0',
      '10.0.0.0/8, ::/0',
      '0.0.0.0/1,128.0.0.0/1',
      '::ffff:0:0/96',
      '::/64',
      '::ffff:10.0.0.0/100',
      '2001:db8::/16',
    ]) {
      vi.stubEnv('HTTP_TRUST_PROXY', trust);
      expect(() => validateAllConfigs()).toThrow(/HTTP_TRUST_PROXY/);
    }
    for (const trust of [
      '1',
      'loopback, 10.0.0.0/8, 172.16.0.0/12',
      '::ffff:10.0.0.0/104, fd00::/48',
      '2001:db8::/32',
    ]) {
      vi.stubEnv('HTTP_TRUST_PROXY', trust);
      expect(() => validateAllConfigs()).not.toThrow();
    }
    vi.stubEnv('HTTP_TRUST_PROXY', '1');
    vi.stubEnv('HTTP_DOCS_ENABLED', 'true');
    vi.stubEnv('HTTP_DOCS_CDN_URL', PINNED_CDN);
    expect(() => validateAllConfigs()).toThrow(/HTTP_DOCS_ENABLED/);
  });
});
