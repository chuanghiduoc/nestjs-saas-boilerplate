import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';

const ENTRY = 'test/support/composition-worker-entry.ts';
const MARKER = 'COMPOSITION_PROBE ';
const CRON_ID = 'static-fixturemod.tick';
const Probe = z.object({
  queues: z.array(z.string()),
  crons: z.array(z.string()),
  namespaces: z.array(z.string()),
  rules: z.array(z.string()),
  envExampleHasFixture: z.boolean(),
  schedulers: z.array(z.string()),
});
const probeOf = (p: AppProcess) => {
  const line = p
    .output()
    .split('\n')
    .find((l) => l.startsWith(MARKER));
  if (!line)
    throw new Error(`no ${MARKER}line in worker output:\n${p.output()}`);
  return Probe.parse(JSON.parse(line.slice(MARKER.length)));
};

describe('disabling a module really disables it (UP-12b, spec SP7 §6.2, R7-17)', () => {
  let worker: AppProcess | undefined;
  afterEach(async () => {
    await stopAppProcess(worker);
    worker = undefined;
  });
  const boot = async (env: Record<string, string>) => {
    await stopAppProcess(worker);
    worker = await startAppProcess(ENTRY, { ...baseTestEnv(), ...env });
    return probeOf(worker);
  };

  it('enable → disable → re-enable', async () => {
    // Pha 1: bật. Mọi thứ của module có mặt, cron đã đồng bộ lên Redis.
    const on = await boot({ FIXTUREMOD_REQUIRED: 'x' });
    expect(on.queues).toContain('fixturemod');
    expect(on.crons).toContain('fixturemod.tick');
    expect(on.namespaces).toContain('fixturemod');
    expect(on.rules).toContain('fixturemod-rule');
    expect(on.envExampleHasFixture).toBe(true);
    expect(on.schedulers).toContain(CRON_ID);

    // Pha 2: tắt, KHÔNG có env bắt buộc của nó. Worker vẫn boot (không lỗi config, không lỗi
    // "Jobs on consumed queues have no @JobHandler"), không còn gì của module, cron đã đồng bộ trước đó bị gỡ.
    const off = await boot({ COMPOSITION_FIXTURE_DISABLE: 'fixturemod' });
    expect(off.queues).not.toContain('fixturemod');
    expect(off.crons).not.toContain('fixturemod.tick');
    expect(off.namespaces).not.toContain('fixturemod');
    expect(off.rules).not.toContain('fixturemod-rule');
    expect(off.envExampleHasFixture).toBe(false);
    expect(off.schedulers).not.toContain(CRON_ID);
    expect(off.schedulers).toEqual(
      expect.arrayContaining([
        'static-identity.purge-expired',
        'static-tenancy.orgs.purge',
      ]),
    );

    // Pha 3 (Review Focus 4): bật lại → cron được đồng bộ lại.
    const again = await boot({ FIXTUREMOD_REQUIRED: 'x' });
    expect(again.schedulers).toContain(CRON_ID);
  });
});
