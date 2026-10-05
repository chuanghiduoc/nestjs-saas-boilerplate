import { randomUUID } from 'node:crypto';
import { Logger, Module, type INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import {
  DatabaseModule,
  OrgScope,
  pgFields,
} from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule, OutboxRelay } from '../../../src/core/outbox/index.js';
import {
  JobQueue,
  QueueModule,
  WorkerHost,
} from '../../../src/core/queue/index.js';
import {
  RedisModule,
  redisClientOptions,
  redisConfig,
  redisNamespace,
} from '../../../src/core/redis/index.js';
import { SchedulerModule } from '../../../src/core/scheduler/index.js';
import { EntitlementCatalogueCheck } from '../../../src/modules/entitlements/application/catalogue-check.js';
import { definePlanCatalogue } from '../../../src/modules/entitlements/domain/plan-catalogue.js';
import {
  Entitlements,
  EntitlementsModule,
  UnknownFeatureError,
} from '../../../src/modules/entitlements/index.js';
import { EntitlementCatalogueReader } from '../../../src/modules/entitlements/ports/catalogue.reader.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { TenancyModule } from '../../../src/modules/tenancy/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import {
  FixtureQueue,
  RecordJob,
  fixtureHandlers,
  seen,
} from '../../fixtures/fixture.jobs.js';
import {
  applyTestEnv,
  buildTestApp,
  createTestApp,
} from '../../support/app-factory.js';
import {
  entitlementsCoreImports,
  startEntitlementsApp,
} from '../../support/entitlements-app.js';
import { FixtureFeaturesModule } from '../../support/entitlements-fixtures.js';
import {
  seedFeatures,
  seedOrgEntitlement,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();

@Module({ providers: fixtureHandlers() })
class FixtureHandlers {}

const DRIFT = /feature fixture\.reports: in code, missing in the database/;

/** Queue BullMQ thô cùng connection/namespace với app (mẫu `test/integration/tenancy/catalogue-check.spec.ts` của 3A). */
function probeFixtureQueue(): Queue {
  applyTestEnv();
  return new Queue(FixtureQueue.name, {
    connection: {
      url: redisConfig().url,
      ...redisClientOptions(redisConfig(), false),
    },
    prefix: redisNamespace(redisConfig(), appConfig()),
  });
}

describe('EntitlementCatalogueCheck (spec SP4 §8.3, criterion 7, EC-9)', () => {
  let app: INestApplication | undefined;
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const boot = async (...args: Parameters<typeof entitlementsCoreImports>) => {
    app = await buildTestApp(entitlementsCoreImports(...args));
    return app.init();
  };

  it('the migrated database matches BoilerplateFeatures + examplePlans: the worker composition boots', async () => {
    await expect(boot(examplePlans)).resolves.toBeDefined();
  });
  it('a registered feature catalogue the migrations never seeded refuses to boot, naming the key', async () => {
    await expect(boot(examplePlans, [FixtureFeaturesModule])).rejects.toThrow(
      /feature fixture\.reports: in code, missing in the database/,
    );
  });
  it('R-X30: a plan row the code does not declare only warns (entitlement_plan_unknown_to_code); the composition boots', async () => {
    cleanups.push(await seedPlans([{ key: 'cc_extra' }]));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const before =
      (await otel.metric('entitlements_catalogue_unknown_plans_total')) ?? 0;
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_plan_unknown_to_code',
      key: 'cc_extra',
    });
    expect(
      await otel.metric('entitlements_catalogue_unknown_plans_total'),
    ).toBe(before + 1);
  });
  it('a retired flag that differs refuses to boot', async () => {
    const retiredPro = definePlanCatalogue({
      defaultPlan: 'free',
      plans: { free: { values: {} }, pro: { retired: true, values: {} } },
    });
    await expect(boot(retiredPro)).rejects.toThrow(
      /plan pro: retired code=true db=false/,
    );
  });
  it('a feature row whose kind differs from the code refuses to boot', async () => {
    cleanups.push(
      await seedFeatures([
        {
          key: 'fixture.reports',
          kind: 'LIMIT',
          resetPeriod: null,
          deprecated: false,
        },
      ]),
    );
    await expect(boot(examplePlans, [FixtureFeaturesModule])).rejects.toThrow(
      /feature fixture\.reports: kind code=FLAG db=LIMIT/,
    );
  });
  it('R-X30: a feature row only in the database warns with its key, counts, boots, and stays out of evaluation', async () => {
    cleanups.push(
      await seedFeatures([
        {
          key: 'cc.ghost',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          deprecated: false,
        },
      ]),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const unknownBefore =
      (await otel.metric('entitlements_catalogue_unknown_features_total')) ?? 0;
    const mismatchBefore =
      (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0;
    const a = await startEntitlementsApp(examplePlans);
    app = a;
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_feature_unknown_to_code',
      key: 'cc.ghost',
    });
    expect(
      await otel.metric('entitlements_catalogue_unknown_features_total'),
    ).toBe(unknownBefore + 1);
    expect(
      (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0,
    ).toBe(mismatchBefore);
    expect(() =>
      a.get(EntitlementCatalogueCheck).featureId('cc.ghost'),
    ).toThrow(UnknownFeatureError);
    const owner = await seedUserPrincipal();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    try {
      await seedOrgEntitlement(org.orgId, 'free');
      const r = await authed(a, owner).get(
        `/v1/orgs/${org.orgId}/entitlements`,
      );
      expect(r.status).toBe(200);
      expect(
        (r.body.features as { key: string }[]).map((f) => f.key),
      ).not.toContain('cc.ghost');
      await expect(
        a
          .get(OrgScope)
          .run(org.orgId, () => a.get(Entitlements).limitOf('cc.ghost')),
      ).rejects.toBeInstanceOf(UnknownFeatureError);
    } finally {
      await org.dispose();
      await deleteSeededPrincipals([owner]);
    }
  });
  it('R-X30: a feature the database already deprecated while the code has not only warns (entitlement_feature_deprecated_in_db)', async () => {
    await withOwner((c) =>
      c.query(
        `UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'tenancy.seats'`,
      ),
    );
    cleanups.push(() =>
      withOwner(async (c) => {
        await c.query(
          `UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'tenancy.seats'`,
        );
      }),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_feature_deprecated_in_db',
      key: 'tenancy.seats',
    });
  });
  it('R-X30: a plan the database already retired while the code has not only warns (entitlement_plan_retired_in_db)', async () => {
    await withOwner((c) =>
      c.query(`UPDATE plans SET retired_at = now() WHERE key = 'pro'`),
    );
    cleanups.push(() =>
      withOwner(async (c) => {
        await c.query(`UPDATE plans SET retired_at = NULL WHERE key = 'pro'`);
      }),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_plan_retired_in_db',
      key: 'pro',
    });
  });
  it('M6 against Postgres: probing a zone the database does not know rejects with SQLSTATE 22023 (PG_UNKNOWN_TIMEZONE); a known zone passes', async () => {
    const a = await boot(examplePlans);
    const reader = a.get(EntitlementCatalogueReader);
    const err: unknown = await reader.probeTimezone('Mars/Olympus').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgFields(err)?.sqlState).toBe('22023');
    await expect(
      reader.probeTimezone('Asia/Ho_Chi_Minh'),
    ).resolves.toBeUndefined();
  });
  it('zero jobs consumed on entitlement catalogue drift: no Worker, no relay, the queued job still waits (3A Task 19 lesson)', async () => {
    // Job xếp hàng TRƯỚC khi worker boot, từ một producer không chạy worker (đóng trước khi worker dựng: một process chỉ có
    // một context MikroORM `app`).
    const probe = probeFixtureQueue();
    cleanups.push(() => probe.close());
    const key = `entitlements-drift-${randomUUID()}`;
    const producer = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
    ]);
    const jobId = await producer
      .get(JobQueue)
      .enqueue(RecordJob, { key }, { jobId: key })
      .finally(() => producer.close());
    cleanups.push(async () => {
      await (await probe.getJob(jobId))?.remove();
    });
    expect(await probe.getJobState(jobId)).toBe('waiting');

    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const workerStarted = vi.spyOn(
      WorkerHost.prototype,
      'onApplicationBootstrap',
    );
    const relayStarted = vi.spyOn(
      OutboxRelay.prototype,
      'onApplicationBootstrap',
    );
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', FixtureQueue.name);
    // Tenancy khớp DB (EntitlementsCoreModule góp `entitlements.read`); chỉ catalogue tính năng lệch (fixture chưa seed).
    app = await buildTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: false }),
      SchedulerModule.forRoot({ worker: false }),
      // `OwnerNotifier` của `TenancyModule.forWorker()` (3D) cần `EmailNotifications`, như `tenancyCoreImports`.
      NotificationsModule.forApi(),
      TenancyModule.forWorker(),
      EntitlementsModule.forWorker(examplePlans),
      FixtureHandlers,
      FixtureFeaturesModule,
    ]);

    await expect(app.init()).rejects.toThrow(DRIFT);
    // `EntitlementCatalogueCheck` chạy ở `onModuleInit`: mọi `onModuleInit` xong trước mọi `onApplicationBootstrap`, nên
    // WorkerHost chưa tạo BullMQ Worker nào và relay chưa claim dòng outbox nào khi boot bị từ chối (tất định).
    expect(workerStarted).not.toHaveBeenCalled();
    expect(relayStarted).not.toHaveBeenCalled();
    expect(await probe.getJobState(jobId)).toBe('waiting');
    expect(seen.some((x) => x.key === key)).toBe(false);
  });
});
