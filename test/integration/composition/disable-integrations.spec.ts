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
  'disabling integrations really disables it (spec SP6 X-9, R-X16)',
  { timeout: PROBE_TIMEOUT_MS },
  () => {
    it('no namespace, queue, job or cron of integrations; markModuleLoaded not called; config still validates', () => {
      const out = execFileSync(
        process.execPath,
        [
          ...TS_LOADER,
          'test/support/composition-disable-probe.ts',
          'integrations',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, ...baseTestEnv() },
          timeout: PROBE_TIMEOUT_MS,
        },
      );
      const r = Probe.parse(JSON.parse(out.trim().split('\n').at(-1) ?? ''));
      expect(r.loaded).not.toContain('integrations');
      expect(r.loaded).toContain('tenancy');
      expect(r.namespaces).not.toContain('integrations');
      expect(r.queues).not.toContain('webhooks-out');
      expect(r.jobs.filter((j) => j.startsWith('integrations.'))).toEqual([]);
      expect(r.crons.filter((c) => c.startsWith('integrations.'))).toEqual([]);
      expect(r.validation).toBe('ok');
    });
  },
);
