import { describe, expect, it } from 'vitest';
import { resilienceConfig } from '../../../../src/core/resilience/index.js';
import {
  DnsUrlGuard,
  type HostResolver,
} from '../../../../src/modules/integrations/infra/dns-url-guard.js';

const PUBLIC_IP = '93.184.215.14';
/** Resolver giả: `localhost*` → loopback; `private*` → RFC1918; `mixed*` → công khai + `::1`; `nx*` → lỗi DNS như Node; `empty*` → []. */
const resolver: HostResolver = async (host) => {
  if (host.startsWith('localhost'))
    return [{ address: '127.0.0.1', family: 4 }];
  if (host.startsWith('private')) return [{ address: '10.0.0.5', family: 4 }];
  if (host.startsWith('mixed'))
    return [
      { address: PUBLIC_IP, family: 4 },
      { address: '::1', family: 6 },
    ];
  if (host.startsWith('nx'))
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
      code: 'ENOTFOUND',
    });
  if (host.startsWith('empty')) return [];
  return [{ address: PUBLIC_IP, family: 4 }];
};
const guard = (env: Record<string, string> = {}) =>
  new DnsUrlGuard(
    resilienceConfig.schema.parse({
      allowedSchemes: 'https',
      allowedPorts: '443',
      allowCidrs: '',
      ...env,
    }),
    resolver,
  );

describe('DnsUrlGuard (spec SP6 §8.3 step 1, W-20, W-21)', () => {
  it('accepts a public https URL and returns its normalised form', async () => {
    expect(await guard().check('https://Hooks.Example.test/a b?x=1')).toEqual({
      ok: true,
      url: 'https://hooks.example.test/a%20b?x=1',
    });
  });
  it.each([
    'https://127.0.0.1/hook',
    'https://10.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]/hook',
    'https://user:pw@hooks.example.test/hook',
    'https://hooks.example.test:8080/hook',
    'http://hooks.example.test/hook',
  ])('refuses %s (W-20)', async (url) => {
    expect(await guard().check(url)).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
  });
  it('refuses a name that resolves to a private address (W-21)', async () => {
    expect(await guard().check('https://private.example.test/hook')).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
  });
  it.each([
    'https://2130706433/',
    'https://0x7f.1/',
    'https://127.1/',
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://LOCALHOST./',
  ])(
    'Review Focus 1: numeric, shortened and trailing-dot hosts are refused: %s',
    async (url) => {
      expect((await guard().check(url)).ok).toBe(false);
    },
  );
  it('Review Focus 2: one private address among public ones is refused; an empty answer too', async () => {
    expect(await guard().check('https://mixed.example.test/hook')).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
    expect(await guard().check('https://empty.example.test/')).toEqual({
      ok: false,
      reason: 'NOT_ALLOWED',
    });
  });
  it('a fragment, a malformed URL, a URL that grows past the column limit, and a name that does not resolve are refused', async () => {
    expect(await guard().check('https://hooks.example.test/hook#frag')).toEqual(
      { ok: false, reason: 'INVALID' },
    );
    expect(await guard().check('not a url')).toEqual({
      ok: false,
      reason: 'INVALID',
    });
    expect(
      await guard().check(`https://hooks.example.test/${'é'.repeat(700)}`),
    ).toEqual({ ok: false, reason: 'INVALID' });
    expect(await guard().check('https://nx.example.test/')).toEqual({
      ok: false,
      reason: 'UNRESOLVABLE',
    });
  });
  it('RESILIENCE_SSRF_ALLOW_CIDRS exempts a private range, as HttpClient does at connect time', async () => {
    expect(
      await guard({ allowCidrs: '10.0.0.0/24' }).check(
        'https://private.example.test/hook',
      ),
    ).toMatchObject({ ok: true });
  });
  it('a resolver failure that is not a DNS error is a bug and is thrown', async () => {
    const broken = new DnsUrlGuard(
      resilienceConfig.schema.parse({}),
      async () => {
        throw new TypeError('boom');
      },
    );
    await expect(broken.check('https://hooks.example.test/')).rejects.toThrow(
      'boom',
    );
  });
});
