import {
  Injectable,
  Logger,
  Module,
  type INestApplicationContext,
  type Type,
} from '@nestjs/common';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import {
  EventSubscriber,
  type EventEnvelope,
} from '../../../src/core/events/index.js';
import { SafeEnqueue } from '../../../src/core/outbox/index.js';
import {
  JobHandler,
  JobQueue,
  defineJob,
  defineQueue,
  type JobContext,
} from '../../../src/core/queue/index.js';
import { OrgLifecycleService } from '../../../src/modules/tenancy/application/org-lifecycle.service.js';
import {
  OrgDeletedEvent,
  OrgPurgedEvent,
} from '../../../src/modules/tenancy/index.js';
import { PurgeOrgJob, purgeJobId } from '../../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const seen = {
  ran: [] as string[],
  deleted: [] as string[],
  purged: [] as string[],
};
/**
 * Queue riêng của file (review I9): `FixtureQueue` của `test/fixtures/fixture.jobs.ts` kéo theo 7 job fixture khác mà
 * `X10WorkerModule` không có handler, và `WorkerHost.assertHandlersFor` từ chối boot khi queue được consume thiếu handler.
 */
const X10Queue = defineQueue('x10-fixture', { kind: 'io' });
const SkipJob = defineJob({
  name: 'fixture.tenant-skip',
  queue: X10Queue,
  version: 1,
  schema: z.object({ key: z.string() }),
});
const RunJob = defineJob({
  name: 'fixture.tenant-run',
  queue: X10Queue,
  version: 1,
  schema: z.object({ key: z.string() }),
  onInactiveOrg: 'run',
});

@Injectable()
@JobHandler(SkipJob)
class SkipHandler {
  handle(ctx: JobContext<{ key: string }>): Promise<void> {
    seen.ran.push(`skip:${ctx.payload.key}`);
    return Promise.resolve();
  }
}
@Injectable()
@JobHandler(RunJob)
class RunHandler {
  handle(ctx: JobContext<{ key: string }>): Promise<void> {
    seen.ran.push(`run:${ctx.payload.key}`);
    return Promise.resolve();
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.x10-deleted', event: OrgDeletedEvent })
class OnDeleted {
  handle(e: EventEnvelope<{ orgId: string }>): Promise<void> {
    seen.deleted.push(e.data.orgId);
    return Promise.resolve();
  }
}
/** Subscriber của `purged` enqueue hai job trong OrgScope của event: org đã mất dòng (R4A-N4). */
@Injectable()
@EventSubscriber({ consumer: 'fixture.x10-purged', event: OrgPurgedEvent })
class OnPurged {
  constructor(private readonly jobs: SafeEnqueue) {}
  async handle(e: EventEnvelope<{ orgId: string }>): Promise<void> {
    seen.purged.push(e.data.orgId);
    await this.jobs.enqueue(RunJob, { key: 'after-purge' });
    await this.jobs.enqueue(SkipJob, { key: 'after-purge' });
  }
}
@Module({ providers: [SkipHandler, RunHandler, OnDeleted, OnPurged] })
class X10Fixtures {}
/**
 * `AppWorkerModule` gọi `DatabaseModule.forRoot` (→ `MikroOrmModule.forRootAsync`, đăng ký context name `app`/`relay`
 * vào danh sách toàn process) ngay lúc module được import, và danh sách chỉ được xoá khi một app đóng. Producer của pha
 * 1 (`tenancyCoreImports()`) cũng đăng ký `app`, nên composition worker thật chỉ được import SAU khi producer đã đóng.
 */
async function startX10Worker(): Promise<INestApplicationContext> {
  const [{ AppWorkerModule }, { bootstrapWorker }] = await Promise.all([
    import('../../../src/app-worker.module.js'),
    import('../../../src/main.worker.js'),
  ]);
  const root: Type<unknown> = AppWorkerModule;
  @Module({ imports: [root, X10Fixtures] })
  class X10WorkerModule {}
  return bootstrapWorker(X10WorkerModule);
}

const until = async (
  pred: () => boolean | Promise<boolean>,
  ms = 30_000,
): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const loggedEvents = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flatMap(([o]) =>
    typeof o === 'object' &&
    o !== null &&
    'event' in o &&
    typeof o.event === 'string'
      ? [o.event]
      : [],
  );

describe('X-10: tenant jobs of a soft-deleted org on the real worker composition (spec SP3 §9.4, T-34)', () => {
  let org: SeededOrg;
  let worker: INestApplicationContext | undefined;
  // `bootstrapWorker` ghi thẳng `process.env.APP_ROLE`; trả lại sau file để không rò sang file khác cùng process.
  const previousRole = process.env.APP_ROLE;
  beforeAll(async () => {
    vi.stubEnv('WORKER_QUEUES', 'events,maintenance,x10-fixture');
    org = await seedOrg();
    // Pha 1 — không worker nào chạy: một job 'skip' nằm sẵn trong queue, một job 'skip' hoãn qua outbox, rồi xoá mềm.
    const producer = await createTestApp(tenancyCoreImports());
    try {
      await producer.get(OrgScope).run(org.orgId, async () => {
        await producer
          .get(JobQueue)
          .enqueue(SkipJob, { key: 'queued-before-delete' });
        await producer
          .get(UnitOfWork)
          .run(() =>
            producer
              .get(SafeEnqueue)
              .enqueue(SkipJob, { key: 'deferred-before-delete' }),
          );
        await producer
          .get(OrgLifecycleService)
          .softDelete({ kind: 'SYSTEM', id: 'test.x10' });
      });
    } finally {
      await producer.close();
    }
  });
  afterAll(async () => {
    await worker?.close();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (
      await withAppClient((c) =>
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
      )
    )
      await org.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips queued and deferred tenant jobs, delivers org.deleted, then purge → org.purged → run job runs, skip job is skipped with a WARN', async () => {
    const info = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    // Pha 2 — worker thật (bootstrapWorker + AppWorkerModule): relay → dispatch → deliver chạy thật.
    worker = await startX10Worker();
    await until(() => seen.deleted.includes(org.orgId));
    await until(
      () =>
        loggedEvents(info).filter((e) => e === 'job_skipped_org_inactive')
          .length +
          loggedEvents(warn).filter(
            (e) => e === 'job_skipped_org_inactive_after_delete',
          ).length >=
        2,
    );
    expect(seen.ran.filter((r) => r.startsWith('skip:'))).toEqual([]);
    expect(loggedEvents(info)).toContain('job_skipped_org_inactive');
    // Purge: đưa org tới hạn rồi enqueue đúng job của cron.
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET purge_after = deleted_at + interval '1 millisecond' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
    await worker
      .get(JobQueue)
      .enqueue(
        PurgeOrgJob,
        {},
        { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } },
      );
    await until(() => seen.purged.includes(org.orgId));
    await until(() => seen.ran.includes('run:after-purge'));
    await until(() =>
      loggedEvents(warn).includes('job_skipped_org_inactive_after_delete'),
    );
    expect(seen.ran).not.toContain('skip:after-purge');
  });
});
