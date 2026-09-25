import type { LookupAddress } from 'node:dns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SsrfBlockedError,
  ssrfLookup,
} from '../../../../src/core/resilience/index.js';

/** Kết quả DNS giả lập cho từng hostname (mô phỏng DNS rebinding / nhiều bản ghi A/AAAA). */
const records = new Map<string, LookupAddress[]>();

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (
      hostname: string,
      options: { all?: boolean },
      cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void,
    ) => {
      if (options.all !== true) throw new Error('ssrfLookup must resolve all');
      const found = records.get(hostname);
      if (!found) {
        const err: NodeJS.ErrnoException = new Error(`ENOTFOUND ${hostname}`);
        err.code = 'ENOTFOUND';
        cb(err, []);
        return;
      }
      cb(null, found);
    },
  };
});

type Outcome = {
  err: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family?: number;
};

function run(hostname: string, all: boolean, allow: string[] = []) {
  return new Promise<Outcome>((resolve) => {
    ssrfLookup(allow)(hostname, { all }, (err, address, family) =>
      resolve({ err, address, family }),
    );
  });
}

describe('ssrfLookup (connect-time DNS check)', () => {
  beforeEach(() => {
    records.clear();
    records.set('public.test', [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    records.set('rebind.test', [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    records.set('metadata.test', [{ address: '169.254.169.254', family: 4 }]);
    records.set('mapped.test', [{ address: '::ffff:10.0.0.1', family: 6 }]);
    records.set('internal.test', [{ address: '10.1.2.3', family: 4 }]);
    records.set('compat-meta.test', [{ address: '::a9fe:a9fe', family: 6 }]);
    records.set('compat-lo.test', [{ address: '::7f00:1', family: 6 }]);
  });

  it('autoSelectFamily ({ all: true }) gets the full vetted list', async () => {
    const r = await run('public.test', true);
    expect(r.err).toBeNull();
    expect(r.address).toEqual(records.get('public.test'));
  });
  it('single-address mode gets the first vetted address and its family', async () => {
    const r = await run('public.test', false);
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });
  it.each([
    'rebind.test',
    'metadata.test',
    'mapped.test',
    'internal.test',
    'compat-meta.test',
    'compat-lo.test',
  ])(
    'rejects %s when ANY resolved address is non-public (both modes)',
    async (host) => {
      for (const all of [true, false]) {
        const r = await run(host, all);
        expect(r.err).toBeInstanceOf(SsrfBlockedError);
        expect(r.err?.message).toMatch(/not allowed/);
      }
    },
  );
  it('allowlisted CIDR lets an internal name through', async () => {
    const r = await run('internal.test', false, ['10.0.0.0/8']);
    expect(r.err).toBeNull();
    expect(r.address).toBe('10.1.2.3');
  });
  it('passes DNS errors through unchanged', async () => {
    const r = await run('missing.test', true);
    expect(r.err?.code).toBe('ENOTFOUND');
  });
});
