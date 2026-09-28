import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import {
  JobScheduler,
  MaintenanceQueue,
  QueueModule,
  defineJob,
} from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import {
  ScheduledTaskService,
  SchedulerModule,
  tenantTaskId,
} from '../../../src/core/scheduler/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import pg from 'pg';

const ROUNDS = 20;
const LOCK_WAIT_POLL_MS = 20;
const INSUFFICIENT_PRIVILEGE = '42501';
const Nightly = defineJob({
  name: 'fixture.tenancy.nightly',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
  tenantSchedulable: true,
});

describe('schedules of a soft-deleted org (spec SP3 §9.4, T-32, X-9, DB2-N5)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const svc = () => app.get(ScheduledTaskService);
  const task = (key: string) => ({
    key,
    job: Nightly,
    cron: '0 2 * * *',
    timezone: 'UTC',
    payload: {},
    enabled: true,
  });
  const suspended = (orgId: string) =>
    app
      .get(OrgScope)
      .run(orgId, () =>
        app
          .get(UnitOfWork)
          .run(() =>
            app
              .get(Db)
              .execute<{ key: string; suspended: boolean }>(
                `SELECT key, suspended_at IS NOT NULL AS suspended FROM scheduled_tasks ORDER BY key`,
              ),
          ),
      );
  const seed = async () => {
    const o = await seedOrg();
    orgs.push(o);
    return o;
  };
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'api');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      SchedulerModule.forRoot({ worker: false }),
    ]);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a schedule created after the soft delete is suspended by the trigger and never reaches Redis', async () => {
    const o = await seed();
    await withAppClient((c) =>
      inOrgTx(c, o.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
        ),
      ),
    );
    await app.get(OrgScope).run(o.orgId, () => svc().upsert(task('late')));
    expect(await suspended(o.orgId)).toEqual([
      { key: 'late', suspended: true },
    ]);
    expect(
      await app.get(JobScheduler).listIds(tenantTaskId(o.orgId, '')),
    ).toEqual([]);
  });
  it(`an upsert racing the soft delete waits for it (FOR SHARE vs FOR NO KEY UPDATE) and ends suspended, ×${ROUNDS}`, async () => {
    const { pg: p } = getInfra();
    const watcher = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await watcher.connect();
    try {
      for (let i = 0; i < ROUNDS; i++) {
        const o = await seed();
        await withAppClient(async (c) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
          await c.query(
            `SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
            [o.orgId],
          );
          await c.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
            [o.orgId],
          );
          const racing = app
            .get(OrgScope)
            .run(o.orgId, () => svc().upsert(task(`race${i}`)));
          // Chờ tới khi INSERT của upsert thật sự đứng đợi khoá dòng org (pg_locks đọc được bởi mọi role).
          for (;;) {
            const { rows } = await watcher.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
            );
            if ((rows[0]?.n ?? 0) > 0) break;
            await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
          }
          await c.query('COMMIT');
          await racing;
        });
        expect(await suspended(o.orgId), `round ${i}`).toEqual([
          { key: `race${i}`, suspended: true },
        ]);
        expect(
          await app.get(JobScheduler).listIds(tenantTaskId(o.orgId, '')),
        ).toEqual([]);
      }
    } finally {
      await watcher.end();
    }
  });
  it('an org that does not exist cannot own a schedule (23503 scheduled_tasks_org_fk)', async () => {
    await expect(
      withAppClient((c) =>
        inOrgTx(c, '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', () =>
          c.query(
            `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ('0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', 'k', 'a.b', '0 1 * * *', 'UTC', '{}', true)`,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'scheduled_tasks_org_fk',
    });
  });

  /**
   * Bài học Task 13: trigger chạy dưới quyền caller đọc `organizations` qua RLS (`id = app_current_org()`). Trigger này
   * KHÔNG hoãn: nó chạy trong chính câu INSERT, cùng `app.org_id` với `WITH CHECK (org_id = app_current_org())` của
   * `scheduled_tasks`. Nên đổi `app.org_id` giữa transaction chỉ cho hai kết cục: context = org của lịch (org thấy được,
   * trigger đọc đúng `deleted_at`), hoặc context khác (org bị giấu, nhưng câu INSERT bị `WITH CHECK` từ chối 42501).
   */
  describe('switching app.org_id mid-transaction (Task 13 lesson)', () => {
    it('back in the org after visiting another: the schedule is still suspended with suspended_at = deleted_at', async () => {
      const a = await seed();
      const b = await seed();
      const row = await withAppClient((c) =>
        inOrgTx(c, a.orgId, async () => {
          await c.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
          );
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [b.orgId]);
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
          await c.query(
            `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'switch', 'a.b', '0 1 * * *', 'UTC', '{}', true)`,
            [a.orgId],
          );
          const { rows } = await c.query<{ same: boolean }>(
            `SELECT s.suspended_at = o.deleted_at AS same FROM scheduled_tasks s JOIN organizations o ON o.id = s.org_id WHERE s.key = 'switch'`,
          );
          return rows;
        }),
      );
      expect(row).toEqual([{ same: true }]);
      expect(await suspended(a.orgId)).toEqual([
        { key: 'switch', suspended: true },
      ]);
    });
    it('in the context of another org, a schedule of the soft-deleted org is refused (42501), never inserted unsuspended', async () => {
      const a = await seed();
      const b = await seed();
      await expect(
        withAppClient((c) =>
          inOrgTx(c, a.orgId, async () => {
            await c.query(
              `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`,
            );
            await c.query(`SELECT set_config('app.org_id', $1, true)`, [
              b.orgId,
            ]);
            await c.query(
              `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'hidden', 'a.b', '0 1 * * *', 'UTC', '{}', true)`,
              [a.orgId],
            );
          }),
        ),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      expect(await suspended(a.orgId)).toEqual([]);
    });
  });
});
