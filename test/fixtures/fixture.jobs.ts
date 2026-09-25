import { Injectable } from '@nestjs/common';
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
@Injectable()
@JobHandler(HangJob)
export class HangHandler {
  async handle(ctx: JobContext<{ key: string }>) {
    slowStarted.get(ctx.payload.key)?.();
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt, aborted: true });
  }
}
