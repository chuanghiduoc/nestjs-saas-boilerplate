import { Injectable, type Type } from '@nestjs/common';
import { z } from 'zod';
import { Db, UnitOfWork } from '../../src/core/database/index.js';
import { RequestContext } from '../../src/core/context/index.js';
import {
  defineJob,
  defineQueue,
  JobHandler,
  type JobContext,
} from '../../src/core/queue/index.js';

export const FixtureQueue = defineQueue('fixture', { kind: 'io' });
export const RecordJob = defineJob({
  name: 'fixture.record',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
});
export const SlowJob = defineJob({
  name: 'fixture.slow',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string(), ms: z.number() }),
});
export const FlakyJob = defineJob({
  name: 'fixture.flaky',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string(), failTimes: z.number() }),
});
export const OrgJob = defineJob({
  name: 'fixture.org',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
  tenantSchedulable: true,
});
/** Chỉ dừng khi signal bị abort — dùng để kiểm tra nhánh hết hạn chờ khi tắt worker. */
export const HangJob = defineJob({
  name: 'fixture.hang',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
});
export const BatchJob = defineJob({
  name: 'fixture.batch',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string(), steps: z.number().int() }),
});
export const ConcurrentOrgJob = defineJob({
  name: 'fixture.concurrent-org',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({
    key: z.string(),
    group: z.string(),
    size: z.number().int(),
  }),
});

const BATCH_STEP_MS = 50;
const BARRIER_TIMEOUT_MS = 5000;
const barrierArrivals = new Map<string, Set<string>>();

/** Mọi handler của FixtureQueue: WorkerHost bắt buộc đủ handler cho queue được consume. */
export const fixtureHandlers = (): Type<unknown>[] => [
  RecordHandler,
  SlowHandler,
  FlakyHandler,
  OrgHandler,
  HangHandler,
  BatchHandler,
  ConcurrentOrgHandler,
];

export const seen: {
  key: string;
  attempt: number;
  requestId?: string;
  orgId?: string;
  sessionOrg?: string;
  aborted?: boolean;
}[] = [];
export const slowStarted = new Map<string, () => void>();
export function waitSlowStart(key: string): Promise<void> {
  return new Promise((resolve) => slowStarted.set(key, resolve));
}

@Injectable()
@JobHandler(RecordJob)
export class RecordHandler {
  async handle(ctx: JobContext<{ key: string }>) {
    seen.push({
      key: ctx.payload.key,
      attempt: ctx.attempt,
      requestId: ctx.meta.requestId,
    });
  }
}
@Injectable()
@JobHandler(SlowJob)
export class SlowHandler {
  async handle(ctx: JobContext<{ key: string; ms: number }>) {
    slowStarted.get(ctx.payload.key)?.();
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}
@Injectable()
@JobHandler(FlakyJob)
export class FlakyHandler {
  async handle(ctx: JobContext<{ key: string; failTimes: number }>) {
    if (ctx.attempt <= ctx.payload.failTimes)
      throw new Error(`flaky attempt ${ctx.attempt}`);
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}
@Injectable()
@JobHandler(OrgJob)
export class OrgHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly ctx: RequestContext,
  ) {}
  async handle(job: JobContext<{ key: string }>) {
    const sessionOrg = await this.uow.run(
      async () =>
        (
          await this.db.execute<{ o: string }>(
            `SELECT current_setting('app.org_id', true) AS o`,
          )
        )[0]!.o,
    );
    seen.push({
      key: job.payload.key,
      attempt: job.attempt,
      orgId: this.ctx.orgId(),
      sessionOrg,
    });
  }
}
/** Handler đúng hợp đồng: chờ tới khi bị abort rồi ném lỗi. */
@Injectable()
@JobHandler(HangJob)
export class HangHandler {
  async handle(ctx: JobContext<{ key: string }>) {
    slowStarted.get(ctx.payload.key)?.();
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt, aborted: true });
    ctx.signal.throwIfAborted();
  }
}
/** Mẫu hay gặp: vòng lặp theo lô thoát sớm khi abort nhưng return bình thường (WorkerHost phải chặn). */
@Injectable()
@JobHandler(BatchJob)
export class BatchHandler {
  async handle(ctx: JobContext<{ key: string; steps: number }>) {
    slowStarted.get(ctx.payload.key)?.();
    for (let i = 0; i < ctx.payload.steps; i++) {
      if (ctx.signal.aborted) break;
      await new Promise((r) => setTimeout(r, BATCH_STEP_MS));
    }
    seen.push({
      key: ctx.payload.key,
      attempt: ctx.attempt,
      aborted: ctx.signal.aborted,
    });
  }
}
/** Mọi job cùng nhóm đợi nhau (đang chạy đồng thời) rồi mới đọc ngữ cảnh CLS và session DB. */
@Injectable()
@JobHandler(ConcurrentOrgJob)
export class ConcurrentOrgHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly ctx: RequestContext,
  ) {}
  async handle(job: JobContext<{ key: string; group: string; size: number }>) {
    const arrived = barrierArrivals.get(job.payload.group) ?? new Set();
    arrived.add(job.payload.key);
    barrierArrivals.set(job.payload.group, arrived);
    const start = Date.now();
    while (arrived.size < job.payload.size) {
      if (Date.now() - start > BARRIER_TIMEOUT_MS)
        throw new Error(`barrier ${job.payload.group} timed out`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const sessionOrg = await this.uow.run(
      async () =>
        (
          await this.db.execute<{ o: string }>(
            `SELECT current_setting('app.org_id', true) AS o`,
          )
        )[0]!.o,
    );
    seen.push({
      key: job.payload.key,
      attempt: job.attempt,
      orgId: this.ctx.orgId(),
      requestId: this.ctx.requestId(),
      sessionOrg,
    });
  }
}
