import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BOILERPLATE_MODULES } from '../../../src/boilerplate.modules.js';
import { baseTestEnv } from '../../support/env.js';

const TS_LOADER = ['--import', '@swc-node/register/esm-register'];
/** Nạp TS qua swc (lạnh) và import cả cây module: rộng hơn nhiều so với thực tế. */
const PROBE_TIMEOUT_MS = 90_000;
const Probe = z.object({
  key: z.string(),
  requires: z.array(z.string()),
  loadedBefore: z.array(z.string()),
  loaded: z.array(z.string()),
  newCrons: z.array(z.string()),
});
const lastJsonLine = (entry: string, args: string[]): unknown => {
  const out = execFileSync(process.execPath, [...TS_LOADER, entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...baseTestEnv() },
    timeout: PROBE_TIMEOUT_MS,
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '');
};

describe(
  'each boilerplate module registers only its own crons and imports only what MODULE_REQUIRES declares (UP-12c)',
  { timeout: PROBE_TIMEOUT_MS * 2 },
  () => {
    it.each(Object.keys(BOILERPLATE_MODULES))('%s', (key) => {
      const r = Probe.parse(
        lastJsonLine('test/support/composition-probe.ts', [key]),
      );
      expect(
        r.loadedBefore,
        'a required module imports this one',
      ).not.toContain(key);
      expect(r.loaded, 'index.ts must call markModuleLoaded').toContain(key);
      expect(
        r.loaded.filter((m) => m !== key && !r.requires.includes(m)),
        'imported modules missing from MODULE_REQUIRES',
      ).toEqual([]);
      expect(
        r.newCrons.filter(
          (c) => !c.startsWith(`${key}.`) && !c.startsWith('core.'),
        ),
        `crons of "${key}" must be keyed "${key}.*"`,
      ).toEqual([]);
    });

    it('a feature that statically imports a disabled module stops the composition, naming the module', () => {
      expect(
        lastJsonLine('test/support/composition-feature-probe.ts', []),
      ).toEqual({
        error:
          'Module "tenancy" is disabled but was imported (by a feature or another module); enable it or remove the import',
      });
    });
  },
);
