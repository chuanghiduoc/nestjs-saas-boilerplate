import { describe, expect, it } from 'vitest';
import {
  detectCredentials,
  type DetectionConfig,
} from '../../../../src/modules/identity/http/credential-detector.js';

const local: DetectionConfig = {
  mode: 'local',
  cookiePrefix: 'app',
  apiKeyHeader: 'x-api-key',
};
const external: DetectionConfig = {
  mode: 'external',
  cookiePrefix: 'app',
  apiKeyHeader: 'x-api-key',
  externalTokenCookie: 'idp_token',
};
const raw = (...pairs: [string, string][]) => pairs.flat();

describe('additional raw-header boundaries', () => {
  it.each(['local', 'hybrid'] as const)(
    'keeps cookie value and name in %s',
    (mode) => {
      expect(
        detectCredentials(
          raw(['cOoKiE', '__Secure-app.session_token=a%2Fb==']),
          { ...local, mode },
        ),
      ).toEqual({
        ok: true,
        credentials: [
          {
            kind: 'SESSION_COOKIE',
            value: 'a%2Fb==',
            cookieName: '__Secure-app.session_token',
          },
        ],
        hasAuthCookie: true,
      });
    },
  );
  it('does not count two-factor/state cookies as credentials', () => {
    expect(
      detectCredentials(
        raw(['Cookie', '__Secure-app.two_factor=x; app.state=y']),
        local,
      ),
    ).toEqual({ ok: true, credentials: [], hasAuthCookie: true });
    expect(
      detectCredentials(
        raw(['Cookie', 'theme=x'], ['Cookie', 'app.session_token=s']),
        local,
      ).ok,
    ).toBe(true);
  });
  it.each([
    [raw(['Cookie', 'idp_token=a; idp_token=b'])],
    [raw(['Cookie', 'idp_token=a'], ['Cookie', 'idp_token=b'])],
    [raw(['Cookie', 'idp_token=a'], ['Authorization', 'Bearer b'])],
  ])('rejects external duplicates/multi-source even at sign-out', (headers) => {
    expect(
      detectCredentials(headers, external, { allowCookieWithBearer: true }).ok,
    ).toBe(false);
  });
  it('does not recognize an external cookie when unconfigured', () => {
    expect(
      detectCredentials(raw(['Cookie', 'idp_token=x; app.session_token=y']), {
        ...local,
        mode: 'external',
      }),
    ).toEqual({ ok: true, credentials: [], hasAuthCookie: false });
  });
  it('sign-out does not bypass duplicates or permit a third credential', () => {
    for (const headers of [
      raw(
        ['Cookie', 'app.session_token=a; app.session_token=a'],
        ['Authorization', 'Bearer b'],
      ),
      raw(
        ['Cookie', 'app.session_token=a'],
        ['Authorization', 'Bearer b'],
        ['x-api-key', 'k'],
      ),
    ]) {
      expect(
        detectCredentials(headers, local, { allowCookieWithBearer: true }).ok,
      ).toBe(false);
    }
  });
  it('rejects incomplete raw header pairs', () => {
    expect(detectCredentials(['Authorization'], local)).toEqual({
      ok: false,
      reason: 'malformed raw headers',
    });
  });
  it('uses a static duplicate reason even for configured secret-looking names', () => {
    expect(
      detectCredentials(
        raw(['Cookie', 'private_name=secret1; private_name=secret2']),
        { ...external, externalTokenCookie: 'private_name' },
      ),
    ).toEqual({ ok: false, reason: 'duplicate credential cookie' });
  });
});

describe('detectCredentials', () => {
  it('no credential → anonymous; unrelated cookies are ignored', () => {
    expect(
      detectCredentials(raw(['Cookie', 'theme=dark; app.state=x']), local),
    ).toEqual({ ok: true, credentials: [], hasAuthCookie: true });
    expect(detectCredentials(raw(['Accept', '*/*']), local)).toEqual({
      ok: true,
      credentials: [],
      hasAuthCookie: false,
    });
  });
  it.each([
    [
      'session cookie',
      raw(['Cookie', 'app.session_token=s1']),
      'SESSION_COOKIE',
      's1',
    ],
    [
      'secure session cookie',
      raw(['Cookie', '__Secure-app.session_token=s2']),
      'SESSION_COOKIE',
      's2',
    ],
    ['bearer', raw(['Authorization', 'Bearer t1']), 'BEARER_SESSION', 't1'],
    ['api key', raw(['X-Api-Key', 'k1']), 'API_KEY', 'k1'],
  ])('%s', (_n, headers, kind, value) => {
    const d = detectCredentials(headers, local);
    expect(d).toMatchObject({ ok: true, credentials: [{ kind, value }] });
  });
  it.each([
    ['bearer', raw(['Authorization', 'bearer t1'])],
    ['BEARER', raw(['Authorization', 'BEARER t1'])],
    ['BeArEr', raw(['Authorization', 'BeArEr t1'])],
  ])(
    '%s scheme (case-insensitive per RFC 7235) → BEARER_SESSION',
    (_n, headers) => {
      expect(detectCredentials(headers, local)).toMatchObject({
        ok: true,
        credentials: [{ kind: 'BEARER_SESSION', value: 't1' }],
      });
    },
  );
  it.each([
    [
      'two Authorization headers',
      raw(['Authorization', 'Bearer a'], ['authorization', 'Bearer b']),
    ],
    ['two API key headers', raw(['x-api-key', 'a'], ['X-API-KEY', 'b'])],
    ['an API key list', raw(['x-api-key', 'a, b'])],
    [
      'two Cookie headers carrying counted cookies',
      raw(['Cookie', 'app.session_token=a'], ['Cookie', 'app.two_factor=b']),
    ],
    [
      'the same session cookie twice',
      raw(['Cookie', 'app.session_token=a; app.session_token=b']),
    ],
    [
      '__Secure- and plain session cookie together',
      raw(['Cookie', '__Secure-app.session_token=a; app.session_token=b']),
    ],
    [
      'two_factor cookie twice',
      raw(['Cookie', 'app.two_factor=a; app.two_factor=b']),
    ],
    ['malformed Authorization', raw(['Authorization', 'Basic dXNlcjpw'])],
    ['empty bearer token', raw(['Authorization', 'Bearer '])],
    [
      'cookie + bearer',
      raw(['Cookie', 'app.session_token=a'], ['Authorization', 'Bearer b']),
    ],
    [
      'bearer + api key',
      raw(['Authorization', 'Bearer b'], ['x-api-key', 'k']),
    ],
  ])('%s → ambiguous', (_n, headers) => {
    expect(detectCredentials(headers, local).ok).toBe(false);
  });
  it('sign-out may carry cookie + bearer (and nothing else)', () => {
    const d = detectCredentials(
      raw(['Cookie', 'app.session_token=a'], ['Authorization', 'Bearer b']),
      local,
      { allowCookieWithBearer: true },
    );
    expect(d).toMatchObject({
      ok: true,
      credentials: [{ kind: 'SESSION_COOKIE' }, { kind: 'BEARER_SESSION' }],
    });
    expect(
      detectCredentials(
        raw(['Cookie', 'app.session_token=a'], ['x-api-key', 'k']),
        local,
        { allowCookieWithBearer: true },
      ).ok,
    ).toBe(false);
  });
  it('external: header + cookie together → ambiguous; cookie alone → EXTERNAL_COOKIE', () => {
    expect(
      detectCredentials(
        raw(['Cookie', 'idp_token=j'], ['Authorization', 'Bearer j']),
        external,
      ).ok,
    ).toBe(false);
    expect(
      detectCredentials(raw(['Cookie', 'idp_token=j']), external),
    ).toMatchObject({
      ok: true,
      credentials: [{ kind: 'EXTERNAL_COOKIE', value: 'j' }],
      hasAuthCookie: true,
    });
    expect(
      detectCredentials(raw(['Authorization', 'Bearer j']), external),
    ).toMatchObject({ ok: true, credentials: [{ kind: 'EXTERNAL_BEARER' }] });
  });
  it('empty or blank credentials are present-but-invalid, never anonymous', () => {
    expect(detectCredentials(raw(['x-api-key', '']), local)).toMatchObject({
      ok: true,
      credentials: [{ kind: 'API_KEY', value: '' }],
    });
    expect(detectCredentials(raw(['x-api-key', '   ']), local)).toMatchObject({
      ok: true,
      credentials: [{ kind: 'API_KEY', value: '' }],
    });
    expect(
      detectCredentials(raw(['Cookie', 'app.session_token=']), local),
    ).toMatchObject({
      ok: true,
      credentials: [{ kind: 'SESSION_COOKIE', value: '' }],
    });
    expect(
      detectCredentials(raw(['Authorization', 'Bearer    ']), local).ok,
    ).toBe(false);
  });
});
