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
  type JobMeta,
} from './job-definition.js';
import { JobQueue, type EnqueueItem, type EnqueueOpts } from './job-queue.js';
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

  private meta(extra?: JobMeta): JobMeta {
    return {
      requestId: this.ctx.requestId(),
      orgId: this.ctx.orgId(),
      traceparent: this.ctx.traceparent(),
      ...extra,
    };
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
    const data = encodeJobData(job, payload, this.meta(opts.meta));
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
          data: encodeJobData(it.job, it.payload, this.meta(it.opts?.meta)),
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

  async onApplicationShutdown(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((q) => q.close()));
  }
}
