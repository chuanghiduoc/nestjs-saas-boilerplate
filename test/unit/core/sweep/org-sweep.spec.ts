import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MaintenanceQueue,
  defineJob,
  defineQueue,
  findJob,
  jobRegistry,
} from '../../../../src/core/queue/index.js';
import {
  cronRegistry,
  defineCron,
} from '../../../../src/core/scheduler/cron-definition.js';
import {
  OrgSweepDefinitionError,
  defineOrgSweep,
  findOrgSweep,
  sweepJobId,
} from '../../../../src/core/sweep/index.js';

const Q = defineQueue('unit-sweep-def', { kind: 'io' });
const OrgJob = defineJob({
  name: 'unit.sweep-def-org',
  queue: Q,
  version: 1,
  schema: z.object({}),
});
const base = {
  orgJob: OrgJob,
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => ({ size: 10, maxBatches: 2 }),
};

describe('defineOrgSweep (spec SP6 §5.3 core/sweep, R-X14)', () => {
  it('registers the sweep, its maintenance job named by key and its cron', () => {
    const def = defineOrgSweep({
      ...base,
      key: 'unit.sweep-orgs-a',
      definerFunction: 'unit_orgs_due',
      jobIdPrefix: 'unit-a',
    });
    expect(findOrgSweep('unit.sweep-orgs-a')).toBe(def);
    expect(findJob('unit.sweep-orgs-a')).toBe(def.job);
    expect(def.job.queue).toBe(MaintenanceQueue);
    expect(cronRegistry().find((c) => c.key === 'unit.sweep-orgs-a')?.job).toBe(
      def.job,
    );
    expect(def.extraParams()).toEqual({});
    expect(sweepJobId(def, '0199a000-0000-7000-8000-000000000001', 42)).toBe(
      'unit-a-0199a000-0000-7000-8000-000000000001-42',
    );
  });
  it.each([
    [{ definerFunction: 'Bad-Name', jobIdPrefix: 'ok' }, /definerFunction/],
    [{ definerFunction: 'public.x', jobIdPrefix: 'ok' }, /definerFunction/],
    [{ definerFunction: 'ok_fn', jobIdPrefix: 'Bad' }, /jobIdPrefix/],
    [{ definerFunction: 'ok_fn', jobIdPrefix: 'a:b' }, /jobIdPrefix/],
  ] as const)('refuses a malformed name %j at definition', (names, re) => {
    expect(() =>
      defineOrgSweep({ ...base, key: 'unit.sweep-orgs-bad', ...names }),
    ).toThrow(OrgSweepDefinitionError);
    expect(() =>
      defineOrgSweep({ ...base, key: 'unit.sweep-orgs-bad', ...names }),
    ).toThrow(re);
  });
  const registered = () => [jobRegistry().length, cronRegistry().length];
  it.each([
    'Bad Key',
    'unit:sweep',
    '.dot',
    '9starts-with-digit',
    `u${'x'.repeat(100)}`,
  ])(
    'refuses key %j with OrgSweepDefinitionError before registering any job or cron',
    (key) => {
      const before = registered();
      expect(() =>
        defineOrgSweep({
          ...base,
          key,
          definerFunction: 'ok_fn',
          jobIdPrefix: 'ok',
        }),
      ).toThrow(OrgSweepDefinitionError);
      expect(() =>
        defineOrgSweep({
          ...base,
          key,
          definerFunction: 'ok_fn',
          jobIdPrefix: 'ok',
        }),
      ).toThrow(/key must match/);
      expect(registered()).toEqual(before);
    },
  );
  it('refuses a key already taken by a job or by a cron, and leaves no half-registered job behind', () => {
    defineJob({
      name: 'unit.sweep-taken-job',
      queue: Q,
      version: 1,
      schema: z.object({}),
    });
    defineCron({
      key: 'unit.sweep-taken-cron',
      job: OrgJob,
      payload: {},
      schedule: base.schedule,
    });
    const before = registered();
    expect(() =>
      defineOrgSweep({
        ...base,
        key: 'unit.sweep-taken-job',
        definerFunction: 'ok_fn',
        jobIdPrefix: 'ok',
      }),
    ).toThrow(/a job named "unit\.sweep-taken-job" is already defined/);
    expect(() =>
      defineOrgSweep({
        ...base,
        key: 'unit.sweep-taken-cron',
        definerFunction: 'ok_fn',
        jobIdPrefix: 'ok',
      }),
    ).toThrow(/a cron with key "unit\.sweep-taken-cron" is already defined/);
    expect(registered()).toEqual(before);
    expect(findJob('unit.sweep-taken-cron')).toBeUndefined();
  });
  it('refuses an org job that does not accept the payload {} (the org travels in meta.orgId)', () => {
    const Strict = defineJob({
      name: 'unit.sweep-def-strict',
      queue: Q,
      version: 1,
      schema: z.object({ fileId: z.string() }),
    });
    expect(() =>
      defineOrgSweep({
        ...base,
        orgJob: Strict,
        key: 'unit.sweep-orgs-strict',
        definerFunction: 'x_due',
        jobIdPrefix: 'x',
      }),
    ).toThrow(/must accept the payload \{\}/);
  });
});
