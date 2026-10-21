import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseTestEnv } from '../../support/env.js';

const TS_LOADER = ['--import', '@swc-node/register/esm-register'];
/** Nạp TS qua swc (lạnh) và import cả cây module. */
const PROBE_TIMEOUT_MS = 90_000;
const Probe = z.object({
  loaded: z.array(z.string()),
  namespaces: z.array(z.string()),
  queues: z.array(z.string()),
  jobs: z.array(z.string()),
  crons: z.array(z.string()),
  validation: z.string(),
});

describe(
  'disabling audit really disables it (spec SP6 X-9, R-X16)',
  { timeout: PROBE_TIMEOUT_MS },
  () => {
    it('no audit namespace; markModuleLoaded not called; its requirements stay loaded; config still validates', () => {
      const out = execFileSync(
        process.execPath,
        [...TS_LOADER, 'test/support/composition-disable-probe.ts', 'audit'],
        {
          encoding: 'utf8',
          env: { ...process.env, ...baseTestEnv() },
          timeout: PROBE_TIMEOUT_MS,
        },
      );
      const r = Probe.parse(JSON.parse(out.trim().split('\n').at(-1) ?? ''));
      expect(r.loaded).not.toContain('audit');
      expect(r.loaded).toEqual(expect.arrayContaining(['identity', 'tenancy']));
      expect(r.namespaces).not.toContain('audit');
      expect(r.validation).toBe('ok');
    });
  },
);
