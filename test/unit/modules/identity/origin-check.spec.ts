import { describe, expect, it } from 'vitest';
import {
  csrfAllows,
  trustedOriginList,
} from '../../../../src/modules/identity/http/origin-check.js';

const trusted = new Set(
  trustedOriginList(['https://app.example.test'], 'https://api.example.test'),
);

describe('origin normalization and malformed inputs', () => {
  it('normalizes scheme, hostname and default port, retaining non-default ports', () => {
    expect(
      trustedOriginList(
        ['HTTPS://APP.example.test:443', 'https://app.example.test'],
        'https://api.example.test:8443/auth',
      ),
    ).toEqual(['https://app.example.test', 'https://api.example.test:8443']);
    expect(
      csrfAllows(
        { method: 'post', origin: 'HTTPS://APP.example.test:443' },
        trusted,
      ),
    ).toBe(true);
    expect(trustedOriginList([], undefined)).toEqual([]);
  });
  it.each([
    'null',
    '',
    'garbage',
    'https://app.example.test.evil.test',
    'http://app.example.test',
    'https://app.example.test:8443',
    'https://app.example.test/path',
    'https://app.example.test/',
    'https://app.example.test?x',
    'https://app.example.test#x',
    'https://user@app.example.test',
    'https://app.example.test https://evil.test',
    'https:app.example.test',
    'https://app.example.test\\evil',
    ' https://app.example.test',
    'https://app.example.test\n',
    'data:text/plain,x',
  ])('rejects %j even with same-origin fallback', (origin) => {
    expect(
      csrfAllows(
        { method: 'POST', origin, secFetchSite: 'same-origin' },
        trusted,
      ),
    ).toBe(false);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'LOCK', 'FROBNICATE'])(
    'requires trust for %s (unlisted/custom verbs are unsafe by default)',
    (method) => {
      expect(csrfAllows({ method }, trusted)).toBe(false);
      expect(csrfAllows({ method, origin: 'https://evil.test' }, trusted)).toBe(
        false,
      );
    },
  );
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe %s', (method) => {
    expect(csrfAllows({ method }, trusted)).toBe(true);
  });
  it('normalizes an IDN host to punycode, both ways', () => {
    const idnTrusted = new Set(
      trustedOriginList(['https://bücher.example.test'], undefined),
    );
    expect([...idnTrusted]).toEqual(['https://xn--bcher-kva.example.test']);
    expect(
      csrfAllows(
        { method: 'POST', origin: 'https://xn--bcher-kva.example.test' },
        idnTrusted,
      ),
    ).toBe(true);
    expect(
      csrfAllows(
        { method: 'POST', origin: 'https://bücher.example.test' },
        idnTrusted,
      ),
    ).toBe(true);
    expect(
      csrfAllows(
        { method: 'POST', origin: 'https://xn--evil-kva.example.test' },
        idnTrusted,
      ),
    ).toBe(false);
  });
});

describe('CSRF for cookie-authenticated requests (spec §5.6.2)', () => {
  it('trusts CORS origins plus the base URL origin', () => {
    expect([...trusted].sort()).toEqual([
      'https://api.example.test',
      'https://app.example.test',
    ]);
  });
  it.each([
    [{ method: 'POST', origin: 'https://app.example.test' }, true],
    [{ method: 'POST', secFetchSite: 'same-origin' }, true],
    [{ method: 'POST' }, false],
    [{ method: 'POST', origin: 'https://evil.test' }, false],
    [{ method: 'POST', origin: 'https://other.example.test' }, false],
    [{ method: 'POST', secFetchSite: 'same-site' }, false],
    [{ method: 'POST', origin: 'null', secFetchSite: 'same-origin' }, false],
    [{ method: 'DELETE', origin: 'https://evil.test' }, false],
    [{ method: 'GET', origin: 'https://evil.test' }, true],
    [{ method: 'HEAD' }, true],
  ])('%j → %s', (input, allowed) =>
    expect(csrfAllows(input, trusted)).toBe(allowed),
  );
});
