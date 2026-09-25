import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import {
  REDIS_NAMESPACE,
  redisClientOptions,
  redisConfig,
} from '../redis/index.js';
import {
  assertEnqueueOpts,
  encodeJobData,
  queueRegistry,
  type JobData,
  type JobDef,
} from './job-definition.js';
import { resolveJobMeta } from './job-meta.js';
import {
  JobQueue,
  type EnqueueItem,
  type EnqueueOpts,
  type QueueStats,
} from './job-queue.js';
import { queueConfig } from './queue.config.js';

/** Liệt kê đủ tham số generic: để mặc định thì các kiểu điều kiện của BullMQ không khớp nhau khi gán. Handler không trả kết quả. */
type BullQueue = Queue<JobData, void, string, JobData, void, string>;
type BulkJob = Parameters<BullQueue['addBulk']>[0][number];

/**
 * Producer trên BullMQ. Mỗi queue một `Queue` tạo lười; BullMQ tự tạo và sở hữu connection
 * từ options (không dùng client `REDIS` dùng chung) và đóng nó trong `close()`.
 */
@Injectable()
export class BullmqJobQueue extends JobQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(BullmqJobQueue.name);
  private readonly queues = new Map<string, BullQueue>();
  /** Sau shutdown không tạo lại `Queue` (connection mới sẽ không bao giờ được đóng). */
  private closed = false;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(queueConfig.KEY)
    private readonly cfg: ConfigOf<typeof queueConfig>,
    private readonly ctx: RequestContext,
  ) {
    super();
  }

  queue(name: string): BullQueue {
    if (this.closed)
      throw new Error(`JobQueue is closed; cannot use queue "${name}"`);
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue<JobData, void, string, JobData, void, string>(name, {
        connection: {
          url: this.redis.url,
          ...redisClientOptions(this.redis, false),
        },
        prefix: this.namespace,
        defaultJobOptions: {
          attempts: this.cfg.attempts,
          backoff: { type: 'exponential', delay: this.cfg.backoffMs },
          removeOnComplete: {
            age: this.cfg.keepCompletedAgeSec,
            count: this.cfg.keepCompletedCount,
          },
          removeOnFail: {
            age: this.cfg.keepFailedAgeSec,
            count: this.cfg.keepFailedCount,
          },
        },
      });
      // EventEmitter ném lỗi 'error' khi không có listener, làm sập process.
      q.on('error', (err: Error) =>
        this.logger.error({ err, queue: name }, 'queue connection error'),
      );
      this.queues.set(name, q);
    }
    return q;
  }

  allQueues(): BullQueue[] {
    return queueRegistry().map((q) => this.queue(q.name));
  }

  enqueue<S extends z.ZodType>(
    job: JobDef<S>,
    payload: z.infer<S>,
    opts: EnqueueOpts = {},
  ): Promise<string> {
    return this.enqueueDynamic(job, payload, opts);
  }

  async enqueueDynamic(
    job: JobDef,
    payload: unknown,
    opts: EnqueueOpts = {},
  ): Promise<string> {
    assertEnqueueOpts(job, opts);
    const data = encodeJobData(
      job,
      payload,
      resolveJobMeta(job, this.ctx, opts.meta),
    );
    const added = await this.queue(job.queue.name).add(job.name, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
    });
    if (!added.id)
      throw new Error(`BullMQ did not return an id for job "${job.name}"`);
    return added.id;
  }

  /** Validate toàn bộ trước khi ghi; mỗi queue một lệnh `addBulk` (atomic trong từng queue). Id trả về theo thứ tự `items`. */
  async enqueueMany(items: EnqueueItem[]): Promise<string[]> {
    const byQueue = new Map<string, { index: number; job: BulkJob }[]>();
    items.forEach((it, index) => {
      assertEnqueueOpts(it.job, it.opts ?? {});
      const list = byQueue.get(it.job.queue.name) ?? [];
      list.push({
        index,
        job: {
          name: it.job.name,
          data: encodeJobData(
            it.job,
            it.payload,
            resolveJobMeta(it.job, this.ctx, it.opts?.meta),
          ),
          opts: { jobId: it.opts?.jobId, delay: it.opts?.delayMs },
        },
      });
      byQueue.set(it.job.queue.name, list);
    });
    const ids = new Map<number, string>();
    for (const [name, list] of byQueue) {
      const added = await this.queue(name).addBulk(list.map((x) => x.job));
      list.forEach((entry, i) => {
        const id = added[i]?.id;
        if (!id)
          throw new Error(
            `BullMQ did not return an id for a bulk job on "${name}"`,
          );
        ids.set(entry.index, id);
      });
    }
    return items.map((_, index) => {
      const id = ids.get(index);
      if (!id) throw new Error(`Missing job id for bulk item ${index}`);
      return id;
    });
  }

  async stats(): Promise<QueueStats[]> {
    const now = Date.now();
    return Promise.all(
      queueRegistry().map(async ({ name }) => {
        const q = this.queue(name);
        const [counts, [oldest]] = await Promise.all([
          q.getJobCounts('waiting'),
          q.getJobs(['waiting'], 0, 0, true),
        ]);
        const waiting = counts.waiting;
        if (waiting === undefined)
          throw new Error(`BullMQ returned no waiting count for "${name}"`);
        const eligibleAt = oldest
          ? Math.max(
              oldest.timestamp + (oldest.opts.delay ?? 0),
              oldest.processedOn ?? 0,
            )
          : undefined;
        return {
          queue: name,
          waiting,
          oldestWaitingAgeMs:
            eligibleAt === undefined ? null : Math.max(0, now - eligibleAt),
        };
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((q) => q.close()));
  }
}
