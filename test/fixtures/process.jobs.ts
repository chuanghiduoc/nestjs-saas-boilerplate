import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import { UnitOfWork } from '../../src/core/database/index.js';
import { Inbox } from '../../src/core/outbox/index.js';
import {
  JobHandler,
  defineJob,
  type JobContext,
} from '../../src/core/queue/index.js';
import { FixtureQueue, fixtureHandlers } from './fixture.jobs.js';
import { FixtureModule, FixtureRepo } from './fixture.module.js';

export const HoldJob = defineJob({
  name: 'fixture.process.hold',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({
    eventId: z.uuid(),
    body: z.string(),
    holdMs: z.number().int().positive(),
  }),
});

/** Ghi một dòng trong transaction rồi giữ transaction `holdMs`; báo tiến độ cho process cha qua IPC. */
@Injectable()
@JobHandler(HoldJob)
export class HoldHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly inbox: Inbox,
    private readonly repo: FixtureRepo,
  ) {}
  async handle(ctx: JobContext<z.infer<typeof HoldJob.schema>>): Promise<void> {
    await this.uow.run(() =>
      this.inbox.once('fixture.process.hold', ctx.payload.eventId, async () => {
        await this.repo.insertSystemNote(ctx.payload.body);
        process.send?.({ started: ctx.payload.body });
        await new Promise((r) => setTimeout(r, ctx.payload.holdMs));
      }),
    );
    process.send?.({ done: ctx.payload.body });
  }
}

/** WorkerHost bắt buộc mọi job của queue được consume (`fixture`) có handler, nên kèm cả handler fixture. */
@Module({
  imports: [FixtureModule],
  providers: [HoldHandler, ...fixtureHandlers()],
})
export class ProcessJobsModule {}
