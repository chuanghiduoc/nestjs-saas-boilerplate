import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import {
  DatabaseModule,
  Db,
  OrgScope,
  RelayDb,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import {
  JobHandler,
  JobPayloadError,
  JobScheduler,
  MaintenanceQueue,
  QueueModule,
  defineJob,
  type JobContext,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  ScheduleReconciler,
  ScheduledTaskService,
  SchedulerModule,
  StaticScheduler,
  defineCron,
  retireCron,
  tenantTaskId,
} from '../../../../src/core/scheduler/index.js';
import {
  FixtureQueue,
  fixtureHandlers,
} from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

const ticks = new Map<string, number>();
const Tick = defineJob({
  name: 'fixture.tick',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ src: z.string() }),
});
const TenantReport = defineJob({
  name: 'fixture.tenant.report',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ src: z.string() }),
  tenantSchedulable: true,
});
/** Trên queue khác (không được consume trong test): dùng để kiểm tra đổi job sang queue khác. */
const TenantMaintReport = defineJob({
  name: 'fixture.tenant.maint-report',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({ src: z.string() }),
  tenantSchedulable: true,
});
defineCron({
  key: 'fixture.every-second',
  job: Tick,
  payload: { src: 'static' },
  schedule: () => ({ cron: '* * * * * *', tz: 'UTC' }),
});

@Injectable()
@JobHandler(Tick)
class TickHandler {
  async handle(ctx: JobContext<{ src: string }>) {
    // BullMQ 6 Job Scheduler sinh jobId `repeat:<schedulerId>:<millis>` (JobScheduler.getSchedulerNextJobId).
    const tickMillis = ctx.jobId.split(':').at(-1) ?? ctx.jobId;
    ticks.set(tickMillis, (ticks.get(tickMillis) ?? 0) + 1);
  }
}
@Injectable()
@JobHandler(TenantReport)
class ReportHandler {
  async handle() {}
}
@Module({ providers: [TickHandler, ReportHandler, ...fixtureHandlers()] })
class H {}

const imports = () => [
  DatabaseModule.forRoot({ relay: true }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: true }),
  OutboxModule.forRoot({ relay: false }),
  SchedulerModule.forRoot({ worker: true }),
  H,
];
const until = async (pred: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * Một app mỗi process: `@mikro-orm/nestjs` giữ tên context (`app`, `relay`) toàn cục nên không
 * dựng được hai app có DatabaseModule cùng lúc. "Worker thứ hai" được mô phỏng bằng các lần
 * `StaticScheduler.sync()` song song chạy liên tục trong lúc cron đang bắn (đúng rủi ro thật:
 * upsert đè scheduler giữa hai mốc), còn worker consume với concurrency > 1.
 */
describe('scheduler', () => {
  let w1: INestApplication;
  let bootAt = 0;
  beforeAll(async () => {
    bootAt = Date.now();
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    w1 = await createTestApp(imports());
  });
  afterAll(async () => {
    // Redis prefix riêng cho file này, nhưng vẫn dọn mọi scheduler đã tạo (tĩnh lẫn tenant).
    const sched = w1.get(JobScheduler);
    for (const id of [
      ...(await sched.listIds('static-')),
      ...(await sched.listIds('task-')),
    ])
      await sched.remove(id);
    await w1.close();
    vi.unstubAllEnvs();
  });

  it('static cron fires exactly once per tick while syncs race it', async () => {
    const racing = (async () => {
      while (ticks.size < 3) {
        await Promise.all([
          w1.get(StaticScheduler).sync(),
          w1.get(StaticScheduler).sync(),
        ]);
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    await until(() => ticks.size >= 3);
    await racing;
    for (const count of ticks.values()) expect(count).toBe(1);
    // Tick thừa với millis khác (không bị dedupe theo jobId) cũng bị phát hiện: tối đa một tick mỗi giây.
    const elapsedSec = Math.ceil((Date.now() - bootAt) / 1000);
    expect(ticks.size).toBeLessThanOrEqual(elapsedSec + 1);
    for (const millis of ticks.keys()) expect(Number(millis) % 1000).toBe(0);
  });

  it('registers the core static crons (reconcile, outbox cleanup) on worker boot', async () => {
    const ids = await w1.get(JobScheduler).listIds('static-');
    expect(ids).toEqual(
      expect.arrayContaining([
        'static-core.scheduler.reconcile',
        'static-core.outbox.cleanup',
      ]),
    );
  });

  it('never removes undeclared static crons implicitly; only retired ones', async () => {
    const sched = w1.get(JobScheduler);
    await sched.upsert(
      'static-from.newer.release',
      Tick,
      { src: 'x' },
      {
        cron: '0 0 1 1 *',
        tz: 'UTC',
      },
    );
    expect((await w1.get(StaticScheduler).sync()).removed).not.toContain(
      'static-from.newer.release',
    );
    retireCron('from.newer.release');
    expect((await w1.get(StaticScheduler).sync()).removed).toContain(
      'static-from.newer.release',
    );
    expect(await sched.get('static-from.newer.release')).toBeUndefined();
  });

  it('parallel syncs converge to a single scheduler per static cron', async () => {
    await Promise.all([
      w1.get(StaticScheduler).sync(),
      w1.get(StaticScheduler).sync(),
    ]);
    const ids = await w1.get(JobScheduler).listIds('static-');
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids).toContain('static-fixture.every-second');
  });

  it('rejects cron keys that would produce an invalid BullMQ scheduler id', () => {
    expect(() =>
      defineCron({
        key: 'bad:key',
        job: Tick,
        payload: { src: 'x' },
        schedule: () => ({ cron: '0 0 1 1 *', tz: 'UTC' }),
      }),
    ).toThrow(/must match/);
  });

  describe('tenant tasks', () => {
    const org = randomUUID();
    const inOrg = <T>(fn: () => Promise<T>) => w1.get(OrgScope).run(org, fn);
    const svc = () => w1.get(ScheduledTaskService);
    const base = {
      key: 'report',
      job: TenantReport,
      cron: '0 8 * * 1',
      timezone: 'UTC',
      payload: { src: 't' },
      enabled: true,
    };

    it('requires org context', async () => {
      await expect(svc().upsert(base)).rejects.toMatchObject({
        error: { code: 'org_context_invalid' },
      });
      await expect(svc().remove('report')).rejects.toMatchObject({
        error: { code: 'org_context_invalid' },
      });
    });

    it('rejects non-schedulable jobs, second-level crons, too-frequent crons, bad tz, bad keys and bad payloads', async () => {
      for (const bad of [
        { ...base, job: Tick },
        { ...base, cron: '* * * * * *' },
        { ...base, cron: '* * * * *' },
        // 4 lần/giờ nhưng hai lần cách nhau 1 phút: lấy mẫu vài lần chạy liên tiếp sẽ bỏ sót.
        { ...base, cron: '0,1,20,40 8 * * 1' },
        // Hai giờ liên tiếp: 23:59 → 00:00 hôm sau.
        { ...base, cron: '0,59 0,23 * * *' },
        { ...base, cron: '@daily' },
        { ...base, cron: '61 8 * * 1' },
        { ...base, timezone: 'Mars/Base' },
        { ...base, timezone: '+07:00' },
        // DST spring-forward 2027-03-14 ở New York: 01:59 EST → 03:00 EDT cách 60s.
        { ...base, cron: '0,59 1,3 * * *', timezone: 'America/New_York' },
        // cron-parser không tính được lịch quanh DST ở đây: 422, không phải 500.
        { ...base, cron: '0 * * * *', timezone: 'Pacific/Chatham' },
        { ...base, cron: '0 2 * * *', timezone: 'Australia/Lord_Howe' },
        { ...base, key: 'bad:key' },
        { ...base, payload: { src: 1 } },
      ]) {
        const err = await inOrg(() => svc().upsert(bad)).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({ error: { status: 422 } });
      }
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([]);
    });

    it('stores the task under RLS and registers a scheduler carrying the org', async () => {
      await inOrg(() => svc().upsert(base));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([
        tenantTaskId(org, 'report'),
      ]);
      const otherOrgSees = await w1
        .get(OrgScope)
        .run(randomUUID(), () =>
          w1
            .get(UnitOfWork)
            .run(() => w1.get(Db).execute('SELECT 1 FROM scheduled_tasks')),
        );
      expect(otherOrgSees).toHaveLength(0);
    });

    it('app_relay reads every org but cannot write', async () => {
      const rows = await w1.get(RelayDb).execute<{
        org_id: string;
      }>('SELECT org_id FROM scheduled_tasks WHERE org_id = ?', [org]);
      expect(rows).toHaveLength(1);
      await expect(
        w1
          .get(RelayDb)
          .execute(
            `UPDATE scheduled_tasks SET enabled = false WHERE org_id = ?`,
            [org],
          ),
      ).rejects.toThrow(/permission denied/);
    });

    it('reconcile restores missing schedulers and repairs drifted ones', async () => {
      await w1.get(JobScheduler).remove(tenantTaskId(org, 'report'));
      await inOrg(() =>
        w1
          .get(UnitOfWork)
          .run(() =>
            w1
              .get(Db)
              .execute(
                `UPDATE scheduled_tasks SET cron = '0 9 * * 1' WHERE key = 'report'`,
              ),
          ),
      );
      const r = await w1.get(ScheduleReconciler).reconcile();
      expect(r.upserted).toBeGreaterThanOrEqual(1);
      expect(
        (await w1.get(JobScheduler).get(tenantTaskId(org, 'report')))?.pattern,
      ).toBe('0 9 * * 1');
    });

    it('reconcile removes orphan tenant schedulers but never static ones', async () => {
      const orphan = tenantTaskId(org, 'ghost');
      await w1.get(JobScheduler).upsert(
        orphan,
        TenantReport,
        { src: 'g' },
        {
          cron: '0 8 * * 1',
          tz: 'UTC',
        },
        { orgId: org },
      );
      const r = await w1.get(ScheduleReconciler).reconcile();
      expect(r.removed).toBeGreaterThanOrEqual(1);
      expect(await w1.get(JobScheduler).get(orphan)).toBeUndefined();
      expect(
        await w1.get(JobScheduler).get('static-fixture.every-second'),
      ).toBeDefined();
      expect(
        await w1.get(JobScheduler).get(tenantTaskId(org, 'report')),
      ).toBeDefined();
    });

    describe('org lock on JobScheduler.upsert (R28, spec §5.4)', () => {
      const pattern = { cron: '0 8 * * 1', tz: 'UTC' };
      const templateOrg = async (id: string) =>
        (
          await w1
            .get(BullmqJobQueue)
            .queue(TenantReport.queue.name)
            .getJobScheduler(id)
        )?.template?.data?.meta.orgId;

      it('inside OrgScope(A), a scheduler for org B is rejected and never created', async () => {
        const id = 'r28-cross';
        await expect(
          inOrg(() =>
            w1
              .get(JobScheduler)
              .upsert(id, TenantReport, { src: 'x' }, pattern, {
                orgId: randomUUID(),
              }),
          ),
        ).rejects.toThrow(JobPayloadError);
        expect(await w1.get(JobScheduler).get(id)).toBeUndefined();
      });

      it('inside OrgScope(A), meta.orgId A (any case), absent or undefined all store org A', async () => {
        const cases = [
          { id: 'r28-same', meta: { orgId: org.toUpperCase() } },
          { id: 'r28-absent', meta: {} },
          { id: 'r28-undefined', meta: { orgId: undefined } },
        ];
        try {
          for (const c of cases) {
            await inOrg(() =>
              w1
                .get(JobScheduler)
                .upsert(c.id, TenantReport, { src: 'x' }, pattern, c.meta),
            );
            expect(await templateOrg(c.id)).toBe(org);
          }
        } finally {
          for (const c of cases) await w1.get(JobScheduler).remove(c.id);
        }
      });

      it('outside any org, the reconciler restores schedulers for several orgs, each with its own org', async () => {
        const orgs = [randomUUID(), randomUUID()];
        for (const o of orgs)
          await w1
            .get(OrgScope)
            .run(o, () => svc().upsert({ ...base, key: 'multi' }));
        for (const o of orgs)
          await w1.get(JobScheduler).remove(tenantTaskId(o, 'multi'));
        const r = await w1.get(ScheduleReconciler).reconcile();
        expect(r.upserted).toBeGreaterThanOrEqual(orgs.length);
        for (const o of orgs)
          expect(await templateOrg(tenantTaskId(o, 'multi'))).toBe(o);
      });
    });

    it('moving a task to a job on another queue leaves exactly one scheduler', async () => {
      await inOrg(() => svc().upsert({ ...base, job: TenantMaintReport }));
      await inOrg(() => svc().upsert({ ...base, job: TenantMaintReport }));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([
        tenantTaskId(org, 'report'),
      ]);
      await inOrg(() => svc().upsert(base));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([
        tenantTaskId(org, 'report'),
      ]);
    });

    it('disabling keeps the row but removes the scheduler, and reconcile does not revive it', async () => {
      await inOrg(() => svc().upsert({ ...base, enabled: false }));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([]);
      await w1.get(ScheduleReconciler).reconcile();
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([]);
      const rows = await inOrg(() =>
        w1.get(UnitOfWork).run(() =>
          w1.get(Db).execute<{
            enabled: boolean;
          }>(`SELECT enabled FROM scheduled_tasks WHERE key = 'report'`),
        ),
      );
      expect(rows).toEqual([{ enabled: false }]);
    });

    it('accepts an hourly cron in a DST zone and stores the canonical timezone', async () => {
      await inOrg(() =>
        svc().upsert({
          ...base,
          key: 'hourly',
          cron: '0 * * * *',
          timezone: 'america/new_york',
        }),
      );
      expect(
        await w1.get(JobScheduler).get(tenantTaskId(org, 'hourly')),
      ).toEqual({ pattern: '0 * * * *', tz: 'America/New_York' });
      const rows = await w1.get(RelayDb).execute<{
        timezone: string;
      }>(`SELECT timezone FROM scheduled_tasks WHERE org_id = ? AND key = 'hourly'`, [org]);
      expect(rows).toEqual([{ timezone: 'America/New_York' }]);
      await inOrg(() => svc().remove('hourly'));
    });

    it('stores the timezone as given (Asia/Ho_Chi_Minh is not renamed to Asia/Saigon)', async () => {
      await inOrg(() =>
        svc().upsert({ ...base, key: 'hcm', timezone: 'Asia/Ho_Chi_Minh' }),
      );
      expect(await w1.get(JobScheduler).get(tenantTaskId(org, 'hcm'))).toEqual({
        pattern: base.cron,
        tz: 'Asia/Ho_Chi_Minh',
      });
      const rows = await w1.get(RelayDb).execute<{
        timezone: string;
      }>(`SELECT timezone FROM scheduled_tasks WHERE org_id = ? AND key = 'hcm'`, [org]);
      expect(rows).toEqual([{ timezone: 'Asia/Ho_Chi_Minh' }]);
      await inOrg(() => svc().remove('hcm'));
    });

    it('remove deletes row and scheduler', async () => {
      await inOrg(() => svc().upsert(base));
      await inOrg(() => svc().remove('report'));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([]);
      const rows = await w1
        .get(RelayDb)
        .execute('SELECT 1 FROM scheduled_tasks WHERE org_id = ?', [org]);
      expect(rows).toHaveLength(0);
    });
  });
});
