import { describe, expect, expectTypeOf, it } from 'vitest';
import { eventRegistry } from '../../../../src/core/events/index.js';
import { findJob, queueRegistry } from '../../../../src/core/queue/index.js';
// `cronRegistry` không export ở index của scheduler (review code M1): import từ file định nghĩa như `core/sweep/org-sweep.ts`.
import { cronRegistry } from '../../../../src/core/scheduler/cron-definition.js';
import {
  DEFINER_LIMIT_MAX,
  findOrgSweep,
} from '../../../../src/core/sweep/index.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/index.js';
import { ExampleFeatures } from '../../../../src/features/example/entitlements.js';
import { ExampleEvents } from '../../../../src/features/example/events.js';
import { exampleConfig } from '../../../../src/features/example/example.config.js';
import {
  PurgeArchivedSweep,
  PurgeOrgJob,
} from '../../../../src/features/example/jobs.js';
import { ExamplePermissions } from '../../../../src/features/example/permissions.js';

describe('example catalogues (EX-U3, EX-U4)', () => {
  it('EX-U3: permissions match table 7.2 flag by flag', () => {
    expect(
      Object.entries(ExamplePermissions.entries).map(([key, e]) => [
        key,
        e.requires,
        e.ownerOnly,
        e.apiKeyEligible,
        e.supportEligible,
        e.grantTo,
      ]),
    ).toEqual([
      [
        'example_projects.read',
        [],
        false,
        true,
        true,
        { admin: true, member: true },
      ],
      [
        'example_projects.write',
        ['example_projects.read'],
        false,
        true,
        false,
        { admin: true, member: true },
      ],
      [
        'example_projects.delete',
        ['example_projects.read'],
        false,
        false,
        false,
        { admin: true, member: false },
      ],
    ]);
  });
  it('EX-U4: two features, one kind each, wide fallbacks', () => {
    expect(ExampleFeatures.features['example.projects']).toMatchObject({
      kind: 'FLAG',
      fallback: true,
    });
    expect(ExampleFeatures.features['example.project_count']).toMatchObject({
      kind: 'QUOTA',
      resetPeriod: 'NONE',
      fallback: UNLIMITED,
    });
    expect(() =>
      ExampleFeatures.requireEnabled('example.project_count' as never),
    ).toThrow(/FLAG/);
    expectTypeOf(ExampleFeatures.requireEnabled).toBeCallableWith(
      // @ts-expect-error requireEnabled accepts FLAG keys only (EX-U4 compile-time half)
      'example.project_count',
    );
  });
  it('EX-U4: the five events declare audit: true, webhook: false (R-X3) and carry ids only', () => {
    const defs = eventRegistry()
      .filter((d) => d.type.startsWith('example.'))
      .sort((a, b) => (a.type < b.type ? -1 : 1));
    expect(defs.map((d) => [d.type, d.version, d.audit, d.webhook])).toEqual([
      ['example.project.archived', 1, true, false],
      ['example.project.created', 1, true, false],
      ['example.project.deleted', 1, true, false],
      ['example.project.unarchived', 1, true, false],
      ['example.project.updated', 1, true, false],
    ]);
    expect(
      ExampleEvents.ProjectCreatedEvent.schema.safeParse({
        projectId: crypto.randomUUID(),
        name: 'x',
      }).success,
    ).toBe(false);
  });
  it('queue, per-org job and sweep follow the cron convention S7-D34', () => {
    expect(queueRegistry().map((q) => q.name)).toContain('example');
    expect(PurgeOrgJob.queue.name).toBe('example');
    expect(findOrgSweep('example.projects.purge-archived')).toBe(
      PurgeArchivedSweep,
    );
    expect(findJob('example.projects.purge-archived')?.queue.name).toBe(
      'maintenance',
    );
    expect(cronRegistry().map((c) => c.key)).toContain(
      'example.projects.purge-archived',
    );
  });
  it('config defaults and bounds (spec §11.1)', () => {
    // Unit project không có infra (`applyTestEnv` đọc container): đọc mặc định của schema (env không đặt `EXAMPLE_*`).
    expect(exampleConfig()).toEqual({
      archivedRetentionSec: 2_592_000,
      purgeCron: '30 3 * * *',
      purgeTz: 'UTC',
      purgeOrgBatchSize: 100,
      purgeMaxBatches: 10,
      purgeRowsPerJob: 1000,
    });
    const s = exampleConfig.schema;
    const bad = [
      { archivedRetentionSec: 3599 },
      { archivedRetentionSec: 31_536_001 },
      { purgeCron: 'nope' },
      { purgeTz: 'Mars/Base' },
      { purgeOrgBatchSize: DEFINER_LIMIT_MAX + 1 },
      { purgeMaxBatches: 0 },
      { purgeRowsPerJob: 10_001 },
    ];
    for (const b of bad)
      expect(
        s.safeParse({ ...exampleConfig(), ...b }).success,
        JSON.stringify(b),
      ).toBe(false);
    expect(PurgeArchivedSweep.extraParams()).toEqual({
      p_retention_sec: 2_592_000,
    });
  });
});
