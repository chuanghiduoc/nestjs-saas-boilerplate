import type { INestApplication } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../src/core/database/index.js';
import { JobQueue } from '../../src/core/queue/index.js';
import { PurgeOrgJob, purgeJobId } from '../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import {
  exitCode,
  killIfAlive,
  sendSigterm,
  startWorker,
} from '../support/spawn-worker.js';
import { tenancyCoreImports } from '../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';

const STALLED_MS = 1_000;
const WAIT_MS = 60_000;

const until = async (
  pred: () => Promise<boolean>,
  ms = WAIT_MS,
): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
/** Có backend đang bị CHÍNH `holderPid` chặn (không đếm lock chờ của cả cluster). */
const blockedBy = async (holderPid: number): Promise<boolean> =>
  (
    await ownerQuery(
      'SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [holderPid],
    )
  ).length > 0;

/**
 * Spec SP3 §18.4: worker bị SIGKILL khi job purge đang giữ transaction (đứng chờ khoá org mà test giữ). Postgres
 * rollback phần của nó; worker thứ hai nhận lại job stalled và purge đúng một lần (một event `tenancy.org.purged`).
 */
describe('worker killed in the middle of an organization purge', () => {
  let producer: INestApplication | undefined;
  const children: ChildProcess[] = [];
  let org: SeededOrg;
  const env = () => ({
    ...baseTestEnv(),
    WORKER_QUEUES: 'maintenance',
    WORKER_HEALTH_PORT: '0',
    HEALTH_DRAIN_DELAY_MS: '0',
    QUEUE_STALLED_INTERVAL_MS: String(STALLED_MS),
    QUEUE_LOCK_DURATION_MS: String(STALLED_MS),
  });
  const exists = () =>
    withAppClient((c) =>
      inOrgTx(
        c,
        org.orgId,
        async () =>
          ((
            await c.query('SELECT 1 FROM organizations WHERE id = $1', [
              org.orgId,
            ])
          ).rowCount ?? 0) === 1,
      ),
    );
  beforeAll(async () => {
    producer = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
  });
  afterEach(() => {
    for (const child of children.splice(0)) killIfAlive(child);
  });
  afterAll(async () => {
    if (org && (await exists())) await org.dispose();
    await producer?.close();
  });

  it('the purge is redelivered and committed exactly once', async () => {
    const app = producer;
    if (!app) throw new Error('producer not started');
    const { pg: p } = getInfra();
    const holder = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.app,
    });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [
        org.orgId,
      ]);
      await holder.query(
        'SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
        [org.orgId],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;
      if (holderPid === undefined) throw new Error('no backend pid');
      const first = await startWorker(env());
      children.push(first.child);
      await app
        .get(OrgScope)
        .run(org.orgId, () =>
          app
            .get(JobQueue)
            .enqueue(
              PurgeOrgJob,
              {},
              { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } },
            ),
        );
      // Job đã vào transaction và đang chờ khoá org của test.
      await until(() => blockedBy(holderPid));
      const firstExit = exitCode(first.child);
      first.child.kill('SIGKILL');
      await firstExit;
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect(await exists()).toBe(true);
    const second = await startWorker(env());
    children.push(second.child);
    await until(async () => !(await exists()));
    const secondExit = exitCode(second.child);
    sendSigterm(second.child);
    expect(await secondExit).toBe(0);
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`,
        [org.orgId],
      ),
    ).toHaveLength(1);
  });
});
