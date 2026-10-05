import { randomUUID } from 'node:crypto';
import { Logger, Module, type INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import { DatabaseModule } from '../../../src/core/database/index.js';
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
import { definePlanCatalogue } from '../../../src/modules/entitlements/domain/plan-catalogue.js';
import { EntitlementsModule } from '../../../src/modules/entitlements/index.js';
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
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { FixtureFeaturesModule } from '../../support/entitlements-fixtures.js';
import { seedFeatures, seedPlans } from '../../support/entitlements-seed.js';

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
  it('a plan row the code does not declare refuses to boot', async () => {
    cleanups.push(await seedPlans([{ key: 'cc_extra' }]));
    await expect(boot(examplePlans)).rejects.toThrow(
      /plan cc_extra: in the database, missing in code/,
    );
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
