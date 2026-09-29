import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerModule } from '../../../src/app-worker.module.js';
import { OrgScope, pgFields } from '../../../src/core/database/index.js';
import { JobQueue, type JobContext } from '../../../src/core/queue/index.js';
import { bootstrapWorker } from '../../../src/main.worker.js';
import { OrgLifecycleService } from '../../../src/modules/tenancy/application/org-lifecycle.service.js';
import {
  PurgeOrgHandler,
  PurgeOrgsHandler,
} from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { PurgeOrgsJob } from '../../../src/modules/tenancy/jobs.js';
import { applyTestEnv, createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  dueOrgIds,
  inOrgTx,
  purgeOrgs,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const until = async (
  pred: () => Promise<boolean>,
  ms = 20_000,
): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const exists = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(
      c,
      orgId,
      async () =>
        ((await c.query('SELECT 1 FROM organizations WHERE id = $1', [orgId]))
          .rowCount ?? 0) === 1,
    ),
  );
const makeDue = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(
        `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
        [orgId],
      ),
    ),
  );
const softDeleteUntil = (orgId: string, inMs: number) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(
        `UPDATE organizations SET deleted_at = now() - interval '1 day', purge_after = clock_timestamp() + make_interval(secs => $2::float8 / 1000) WHERE id = $1`,
        [orgId, inMs],
      ),
    ),
  );
const jobCtx = (orgId?: string): JobContext<unknown> => ({
  payload: {},
  meta: orgId ? { orgId } : {},
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
/**
 * Producer = `tenancyCoreImports()` (Task 19: core + `TenancyModule.forWorker()`, `runWorkers: false`): đủ cho
 * `PurgeOrgsHandler` enqueue qua `JobQueue`; không worker nào chạy nên `WorkerHost` không kiểm handler.
 *
 * Consumer = composition worker THẬT (review I8). Với `runWorkers: true`, `WorkerHost.assertHandlersFor` đòi handler cho
 * MỌI job đăng ký trên queue được consume; trên `maintenance` có `core.outbox.cleanup` (cần `OutboxModule` relay),
 * `core.scheduler.reconcile` (cần `SchedulerModule` worker), job maintenance của identity và notifications (kéo vào qua
 * `tenancy/index.ts` → identity). Chỉ `AppWorkerModule` (có `TenancyModule.forWorker()` từ `APP_MODULES`, Task 19) có đủ.
 * `bootstrapWorker` ghi thẳng `process.env.APP_ROLE = 'worker'`; caller đã `vi.stubEnv('APP_ROLE', 'worker')` nên
 * `vi.unstubAllEnvs()` trả lại giá trị cũ.
 */
const startConsumer = (): Promise<INestApplicationContext> =>
  bootstrapWorker(AppWorkerModule);
/** Cron `tenancy.orgs.purge` của worker thật không được tự chạy giữa test (đếm lô, org "chưa tới lượt"): 00:00 ngày 1/1. */
const NEVER_DURING_TEST_CRON = '0 0 1 1 *';

describe('organization purge (spec SP3 §9.5)', () => {
  const orgs: SeededOrg[] = [];
  afterAll(async () => {
    for (const o of orgs) if (await exists(o.orgId)) await o.dispose();
    vi.unstubAllEnvs();
  });

  describe('through the real queue (worker consumes maintenance)', () => {
    let app: INestApplicationContext;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'maintenance');
      vi.stubEnv('TENANCY_ORG_PURGE_CRON', NEVER_DURING_TEST_CRON);
      // `bootstrapWorker` validate config từ `process.env` (không qua `createTestApp`): env test phải có trước.
      applyTestEnv();
      await purgeOrgs(await dueOrgIds());
      app = await startConsumer();
    });
    afterAll(async () => {
      await app?.close();
    });
    const scoped = <T>(orgId: string, fn: () => Promise<T>) =>
      app.get(OrgScope).run(orgId, fn);

    it('purges a due org end to end (cron job → per-org job → handler), leaves others, emits org.purged, removes schedules', async () => {
      const due = await seedOrg();
      const active = await seedOrg();
      const notYet = await seedOrg();
      orgs.push(due, active, notYet);
      await withAppClient((c) =>
        inOrgTx(c, due.orgId, () =>
          c.query(
            `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'purge.probe', 'fixture.noop', '0 * * * *', 'UTC', '{}', true)`,
            [due.orgId],
          ),
        ),
      );
      await makeDue(due.orgId);
      await softDeleteUntil(notYet.orgId, 3_600_000);
      await app.get(JobQueue).enqueue(PurgeOrgsJob, {});
      await until(async () => !(await exists(due.orgId)));
      expect([await exists(active.orgId), await exists(notYet.orgId)]).toEqual([
        true,
        true,
      ]);
      const events = await ownerQuery<{ type: string }>(
        `SELECT type FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`,
        [due.orgId],
      );
      expect(events).toHaveLength(1);
      // Chạy lại trên org đã mất: no-op, không ném (T-14, T-26).
      expect(
        await scoped(due.orgId, () =>
          app.get(PurgeOrgHandler).handle(jobCtx(due.orgId)),
        ),
      ).toBe('gone');
    });
    it('a forgotten participant (fixture table with RESTRICT FK) fails the job loud and keeps the org', async () => {
      const org = await seedOrg();
      orgs.push(org);
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [
            org.orgId,
          ]),
        ),
      );
      await makeDue(org.orgId);
      const err = await scoped(org.orgId, () =>
        app.get(PurgeOrgHandler).handle(jobCtx(org.orgId)),
      ).catch((e: unknown) => e);
      expect(pgFields(err)?.sqlState).toBe('23001');
      expect(await exists(org.orgId)).toBe(true);
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [
            org.orgId,
          ]),
        ),
      );
    });
    it('T-13: restore racing purge — a due org is purged and restore answers 404; a not-yet-due org is restored and purge is skipped', async () => {
      for (let i = 0; i < 10; i++) {
        const dueOrg = await seedOrg();
        const laterOrg = await seedOrg();
        orgs.push(dueOrg, laterOrg);
        await makeDue(dueOrg.orgId);
        await softDeleteUntil(laterOrg.orgId, 3_600_000);
        for (const [org, expected] of [
          [dueOrg, 'purged'],
          [laterOrg, 'skipped'],
        ] as const) {
          const [restore, purge] = await Promise.allSettled([
            scoped(org.orgId, () =>
              app
                .get(OrgLifecycleService)
                .restore({ kind: 'SYSTEM', id: 'test.t13' }),
            ),
            scoped(org.orgId, () =>
              app.get(PurgeOrgHandler).handle(jobCtx(org.orgId)),
            ),
          ]);
          expect(purge).toEqual({ status: 'fulfilled', value: expected });
          expect(restore.status).toBe(
            expected === 'purged' ? 'rejected' : 'fulfilled',
          );
        }
      }
    });
    it('X-11: waiting on the org lock across purge_after — restore then answers 404, purge then purges', async () => {
      for (const action of ['restore', 'purge'] as const) {
        const org = await seedOrg();
        orgs.push(org);
        await softDeleteUntil(org.orgId, 1_000);
        await withAppClient(async (holder) => {
          await holder.query('BEGIN');
          await holder.query(`SELECT set_config('app.org_id', $1, true)`, [
            org.orgId,
          ]);
          await holder.query(
            'SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
            [org.orgId],
          );
          const pending =
            action === 'restore'
              ? scoped(org.orgId, () =>
                  app
                    .get(OrgLifecycleService)
                    .restore({ kind: 'SYSTEM', id: 'test.x11' }),
                ).then(
                  () => 'restored',
                  (e: unknown) => e,
                )
              : scoped(org.orgId, () =>
                  app.get(PurgeOrgHandler).handle(jobCtx(org.orgId)),
                );
          await new Promise((r) => setTimeout(r, 1_500));
          await holder.query('COMMIT');
          const outcome = await pending;
          if (action === 'restore')
            expect(outcome).toMatchObject({ error: { code: 'not_found' } });
          else expect(outcome).toBe('purged');
        });
      }
    });
  });

  describe('many batches with the worker stopped, then consumed (T-14)', () => {
    const batchOrgs: SeededOrg[] = [];
    it('the cron walks batches by cursor, warns on backlog, and a second run adds no duplicate jobs', async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'maintenance');
      vi.stubEnv('TENANCY_ORG_PURGE_BATCH_SIZE', '2');
      vi.stubEnv('TENANCY_ORG_PURGE_MAX_BATCHES', '2');
      vi.stubEnv('TENANCY_ORG_PURGE_CRON', NEVER_DURING_TEST_CRON);
      await purgeOrgs(await dueOrgIds());
      for (let i = 0; i < 5; i++) batchOrgs.push(await seedOrg());
      orgs.push(...batchOrgs);
      for (const o of batchOrgs) await makeDue(o.orgId);
      const producer = await createTestApp(tenancyCoreImports());
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const waiting = async () =>
          (await producer.get(JobQueue).stats()).find(
            (s) => s.queue === 'maintenance',
          )?.waiting ?? 0;
        const before = await waiting();
        expect(await producer.get(PurgeOrgsHandler).handle(jobCtx())).toBe(4);
        expect(
          warn.mock.calls.some(
            ([o]) =>
              typeof o === 'object' &&
              o !== null &&
              'event' in o &&
              o.event === 'org_purge_backlog',
          ),
        ).toBe(true);
        expect(await producer.get(PurgeOrgsHandler).handle(jobCtx())).toBe(4);
        expect((await waiting()) - before).toBe(4);
      } finally {
        warn.mockRestore();
        await producer.close();
      }
      const consumer = await startConsumer();
      try {
        await until(async () =>
          (
            await Promise.all(batchOrgs.slice(0, 4).map((o) => exists(o.orgId)))
          ).every((e) => !e),
        );
        expect(await exists(batchOrgs[4]!.orgId)).toBe(true);
        await consumer.get(JobQueue).enqueue(PurgeOrgsJob, {});
        await until(async () => !(await exists(batchOrgs[4]!.orgId)));
      } finally {
        await consumer.close();
      }
    });
  });
});
