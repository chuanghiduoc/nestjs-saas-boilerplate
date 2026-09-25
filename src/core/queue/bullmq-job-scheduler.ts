import { Injectable } from '@nestjs/common';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { encodeJobData, type JobDef, type JobMeta } from './job-definition.js';

/** BullMQ sinh jobId `repeat:<schedulerId>:<millis>` và từ chối jobId có nhiều hơn hai `:`. */
const SCHEDULER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type SchedulePattern = { cron: string; tz: string };

/**
 * Lịch lặp trên queue (BullMQ Job Schedulers). Một id chỉ tồn tại trên đúng một queue;
 * `upsert` idempotent nên nhiều process gọi song song vẫn hội tụ về một scheduler.
 */
export abstract class JobScheduler {
  abstract upsert(
    id: string,
    job: JobDef,
    payload: unknown,
    pattern: SchedulePattern,
    meta?: JobMeta,
  ): Promise<void>;
  abstract remove(id: string): Promise<void>;
  abstract listIds(prefix: string): Promise<string[]>;
  abstract get(
    id: string,
  ): Promise<{ pattern?: string; tz?: string } | undefined>;
}

@Injectable()
export class BullmqJobScheduler extends JobScheduler {
  constructor(private readonly queues: BullmqJobQueue) {
    super();
  }

  async upsert(
    id: string,
    job: JobDef,
    payload: unknown,
    pattern: SchedulePattern,
    meta: JobMeta = {},
  ): Promise<void> {
    if (!SCHEDULER_ID_PATTERN.test(id))
      throw new Error(
        `Scheduler id "${id}" must match ${SCHEDULER_ID_PATTERN}`,
      );
    const data = encodeJobData(job, payload, meta);
    await this.queues
      .queue(job.queue.name)
      .upsertJobScheduler(
        id,
        { pattern: pattern.cron, tz: pattern.tz },
        { name: job.name, data },
      );
    // Job đổi sang queue khác: bỏ bản cũ để id không chạy trên hai queue.
    for (const q of this.queues.allQueues())
      if (q.name !== job.queue.name) await q.removeJobScheduler(id);
  }

  async remove(id: string): Promise<void> {
    for (const q of this.queues.allQueues()) await q.removeJobScheduler(id);
  }

  async listIds(prefix: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const q of this.queues.allQueues())
      for (const s of await q.getJobSchedulers())
        if (s.key.startsWith(prefix)) ids.add(s.key);
    return [...ids];
  }

  async get(
    id: string,
  ): Promise<{ pattern?: string; tz?: string } | undefined> {
    for (const q of this.queues.allQueues()) {
      const s = await q.getJobScheduler(id);
      if (s) return { pattern: s.pattern, tz: s.tz };
    }
    return undefined;
  }
}
