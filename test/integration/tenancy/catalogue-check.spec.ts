import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Module } from '@nestjs/common';
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
import { PermissionCatalogueContributor } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../../../src/modules/tenancy/application/tenancy-metrics.js';
import { defineCatalogue } from '../../../src/modules/tenancy/domain/catalogue.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { TenancyModule } from '../../../src/modules/tenancy/index.js';
import { SqlCatalogueReader } from '../../../src/modules/tenancy/infra/sql/sql-catalogue.reader.js';
import {
  CatalogueReader,
  type CatalogueRow,
} from '../../../src/modules/tenancy/ports/catalogue-reader.js';
import { EntitlementPermissionsCatalogueModule } from '../../support/entitlement-permissions.module.js';
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
  type ConfigureTestingModule,
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

/**
 * Đọc dòng thật của DB rồi biến đổi (không ghi DB dùng chung: spec khác boot song song trên cùng DB). Mô phỏng
 * một DB chứa dòng của plan khác (orphan) hoặc dòng lệch cờ. Thay provider `CatalogueReader` qua `configure`.
 */
class AlteredCatalogueReader extends CatalogueReader {
  constructor(
    private readonly inner: CatalogueReader,
    private readonly alter: (rows: CatalogueRow[]) => CatalogueRow[],
  ) {
    super();
  }
  async readAll(): Promise<CatalogueRow[]> {
    return this.alter(await this.inner.readAll());
  }
}
const alteringDatabaseRows =
  (alter: (rows: CatalogueRow[]) => CatalogueRow[]): ConfigureTestingModule =>
  (b) =>
    b.overrideProvider(CatalogueReader).useFactory({
      factory: (inner: SqlCatalogueReader) =>
        new AlteredCatalogueReader(inner, alter),
      inject: [SqlCatalogueReader],
    });
const orphanRow = (key: string): CatalogueRow => ({
  key,
  resource: 'other',
  action: 'read',
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  deprecated: false,
  requires: [],
});

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

  it('database keys no loaded catalogue declares (orphans) boot with one WARN and the orphan counter (R-X21)', async () => {
    const configure = alteringDatabaseRows((rows) => [
      ...rows,
      orphanRow('other.write'),
      orphanRow('other.read'),
    ]);
    const warned = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errored = captureCheckErrors();
    const app = await buildTestApp(tenancyCoreImports(), { configure });
    cleanups.push(() => app.close());
    const orphanCount = vi.spyOn(
      app.get(TenancyMetrics).catalogueOrphanKeys,
      'add',
    );
    await expect(app.init()).resolves.toBe(app);
    const orphanWarnings = warned.mock.calls.filter(
      ([payload]) =>
        typeof payload === 'object' &&
        payload !== null &&
        'event' in payload &&
        payload.event === 'catalogue_orphan_keys',
    );
    expect(orphanWarnings).toEqual([
      [
        { event: 'catalogue_orphan_keys', keys: ['other.read', 'other.write'] },
        'permission keys in the database are not declared by any loaded catalogue; they are inert',
      ],
    ]);
    expect(orphanCount).toHaveBeenCalledExactlyOnceWith(2, { source: 'boot' });
    expect(errored).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'catalogue_mismatch' }),
      expect.anything(),
    );
  });

  it('a flag drift still refuses to boot even alongside an orphan (a missing code key is the fixture case above)', async () => {
    const configure = alteringDatabaseRows((rows) => [
      ...rows.map((r) =>
        r.key === 'org.read'
          ? { ...r, supportEligible: !r.supportEligible }
          : r,
      ),
      orphanRow('other.read'),
    ]);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logged = captureCheckErrors();
    const app = await buildTestApp(tenancyCoreImports(), { configure });
    cleanups.push(() => app.close());
    await expect(app.init()).rejects.toThrow(/org\.read: supportEligible/);
    expect(logged).toHaveBeenCalledWith(
      {
        event: 'catalogue_mismatch',
        differences: [expect.stringMatching(/^org\.read: supportEligible /)],
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
      // Như `AppWorkerModule`: service vòng đời org của tenancy (core) cần `EventPublisher` và `ScheduledTaskService`.
      EventsModule.forRoot({ worker: true }),
      SchedulerModule.forRoot({ worker: true }),
      // `OwnerNotifier` của `TenancyModule.forWorker()` (3D) cần `EmailNotifications`, như `tenancyCoreImports`.
      NotificationsModule.forApi(),
      TenancyModule.forWorker(),
      EntitlementPermissionsCatalogueModule,
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
