import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import { DatabaseModule } from '../../../src/core/database/index.js';
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
import { PermissionCatalogueContributor } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { defineCatalogue } from '../../../src/modules/tenancy/domain/catalogue.js';
import { TenancyModule } from '../../../src/modules/tenancy/index.js';
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
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

const Fixture = defineCatalogue('fixture', {
  'fixture.read': {
    resource: 'fixture',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: false, member: false },
  },
});
@Injectable()
@PermissionCatalogueContributor(Fixture)
class FixtureContributor {}
@Module({ providers: [FixtureContributor] })
class FixtureCatalogueModule {}
@Module({ providers: fixtureHandlers() })
class FixtureHandlers {}

const MISMATCH = /fixture\.read: in code, missing in the database/;

/** Queue BullMQ thô cùng connection/namespace với app (mẫu `queue-dashboard.spec.ts`): quan sát job độc lập với app. */
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

describe('CatalogueCheck (spec SP3 §8.8, tiêu chí 14)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  /** Bắt log ERROR của `CatalogueCheck` (mong đợi ở ca lệch): console sạch và nội dung log được kiểm. */
  const captureCheckErrors = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  it('the migrated database matches the tenancy catalogue: the app boots (api boot: every tenancy e2e)', async () => {
    const app = await buildTestApp(tenancyCoreImports());
    cleanups.push(() => app.close());
    await expect(app.init()).resolves.toBe(app);
  });

  it('a registered catalogue the migrations never seeded refuses to boot, naming the key', async () => {
    const logged = captureCheckErrors();
    const app = await buildTestApp([
      ...tenancyCoreImports(),
      FixtureCatalogueModule,
    ]);
    cleanups.push(() => app.close());
    await expect(app.init()).rejects.toThrow(MISMATCH);
    expect(logged).toHaveBeenCalledWith(
      {
        event: 'catalogue_mismatch',
        differences: ['fixture.read: in code, missing in the database'],
      },
      'permission catalogue in code does not match the database',
    );
  });

  it('a drifted worker refuses to boot before it consumes anything: no Worker, no relay, the queued job still waits', async () => {
    // Job xếp hàng TRƯỚC khi worker boot, từ một producer không chạy worker (đóng trước khi worker dựng: một process
    // chỉ có một context MikroORM `app`).
    const probe = probeFixtureQueue();
    cleanups.push(() => probe.close());
    const key = `catalogue-drift-${randomUUID()}`;
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

    captureCheckErrors();
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
    const worker = await buildTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      TenancyModule.forWorker(),
      FixtureHandlers,
      FixtureCatalogueModule,
    ]);
    cleanups.push(() => worker.close());

    await expect(worker.init()).rejects.toThrow(MISMATCH);
    // `CatalogueCheck` chạy ở `onModuleInit`: mọi `onModuleInit` xong trước mọi `onApplicationBootstrap`, nên
    // WorkerHost chưa tạo BullMQ Worker nào và relay chưa claim dòng outbox nào khi boot bị từ chối (tất định).
    expect(workerStarted).not.toHaveBeenCalled();
    expect(relayStarted).not.toHaveBeenCalled();
    expect(await probe.getJobState(jobId)).toBe('waiting');
    expect(seen.some((s) => s.key === key)).toBe(false);
  });
});
