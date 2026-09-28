import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { OrgScope } from '../database/index.js';
import { QueueMetrics } from '../observability/queue-metrics.js';
import {
  currentTraceId,
  withRemoteParent,
} from '../observability/trace-propagation.js';
import {
  REDIS_NAMESPACE,
  redisClientOptions,
  redisConfig,
} from '../redis/index.js';
import {
  JobHandlerMarker,
  isJobHandlerInstance,
  type JobHandlerInstance,
} from './job-handler.decorator.js';
import {
  decodeJobData,
  JobPayloadError,
  jobRegistry,
  queueRegistry,
  type JobData,
  type JobDef,
  type JobMeta,
  type QueueDef,
} from './job-definition.js';
import { OrgActivityGate } from './org-activity-gate.js';
import { queueConfig } from './queue.config.js';

export const WORKER_HOST_OPTIONS = Symbol('core.workerHostOptions');
export type WorkerHostOptions = { runWorkers: boolean };

const SHUTDOWN_ABORT_REASON = 'worker shutdown timeout';

/** Giữ lỗi gốc làm `cause` để log `failed` còn stack của nơi phát hiện dữ liệu sai. */
function unrecoverable(e: JobPayloadError): UnrecoverableError {
  const err = new UnrecoverableError(e.message);
  err.cause = e;
  return err;
}

/** Resolve 'timeout' sau `ms`, timer luôn được huỷ. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Consumer: tìm các class `@JobHandler`, và nếu `runWorkers` thì tạo một BullMQ Worker cho
 * mỗi queue trong `WORKER_QUEUES` (rỗng = mọi queue đã đăng ký). Handler không import BullMQ.
 */
@Injectable()
export class WorkerHost
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WorkerHost.name);
  private readonly workers: Worker<JobData>[] = [];
  private closing: Promise<void> | undefined;
  private readonly handlers = new Map<
    string,
    { def: JobDef; instance: JobHandlerInstance }
  >();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly ctx: RequestContext,
    private readonly orgScope: OrgScope,
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(queueConfig.KEY)
    private readonly cfg: ConfigOf<typeof queueConfig>,
    @Inject(WORKER_HOST_OPTIONS) private readonly opts: WorkerHostOptions,
    private readonly queueMetrics: QueueMetrics,
    @Optional() private readonly orgGate?: OrgActivityGate,
  ) {}

  onApplicationBootstrap(): void {
    this.discoverHandlers();
    if (!this.opts.runWorkers) return;
    // Validate hết trước khi tạo Worker nào, để cấu hình sai không để lại connection mở.
    const queues = this.resolveQueues();
    this.assertHandlersFor(queues);
    for (const q of queues) this.startWorker(q);
  }

  /** Job trên queue được consume mà thiếu handler sẽ thất bại vĩnh viễn lúc chạy; báo ngay lúc boot. */
  private assertHandlersFor(queues: QueueDef[]): void {
    const consumed = new Set(queues.map((q) => q.name));
    const missing = jobRegistry()
      .filter((j) => consumed.has(j.queue.name) && !this.handlers.has(j.name))
      .map((j) => `${j.name} (queue ${j.queue.name})`);
    if (missing.length)
      throw new Error(
        `Jobs on consumed queues have no @JobHandler: ${missing.join(', ')}`,
      );
  }

  private discoverHandlers(): void {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: JobHandlerMarker.KEY,
    })) {
      const def = this.discovery.getMetadataByDecorator(
        JobHandlerMarker,
        wrapper,
      );
      if (!def) continue;
      if (
        !wrapper.isDependencyTreeStatic() ||
        !isJobHandlerInstance(wrapper.instance)
      )
        throw new Error(
          `@JobHandler(${def.name}) class must be a singleton provider implementing handle(ctx)`,
        );
      if (this.handlers.has(def.name))
        throw new Error(`Duplicate @JobHandler for "${def.name}"`);
      this.handlers.set(def.name, { def, instance: wrapper.instance });
    }
  }

  private resolveQueues(): QueueDef[] {
    const registry = queueRegistry();
    const wanted = this.cfg.workerQueues.length
      ? this.cfg.workerQueues
      : registry.map((q) => q.name);
    const unknownOverride = Object.keys(this.cfg.concurrencyOverrides).find(
      (name) => !registry.some((q) => q.name === name),
    );
    if (unknownOverride)
      throw new Error(
        `QUEUE_CONCURRENCY_OVERRIDES contains unknown queue "${unknownOverride}"`,
      );
    return wanted.map((name) => {
      const q = registry.find((x) => x.name === name);
      if (!q) throw new Error(`WORKER_QUEUES contains unknown queue "${name}"`);
      if (q.kind === 'cpu')
        throw new Error(
          `Queue "${name}" is cpu-bound; sandboxed processors are not implemented yet (ADR 0006)`,
        );
      return q;
    });
  }

  private startWorker(q: QueueDef): void {
    const concurrency =
      this.cfg.concurrencyOverrides[q.name] ??
      (q.kind === 'cpu' ? this.cfg.cpuConcurrency : this.cfg.ioConcurrency);
    // Processor phải khai báo đủ 3 tham số: BullMQ chỉ tạo AbortSignal khi `processor.length >= 3`.
    const worker = new Worker<JobData>(
      q.name,
      (job, _token, signal) => this.process(job, signal),
      {
        connection: {
          url: this.redis.url,
          ...redisClientOptions(this.redis, true),
        },
        prefix: this.namespace,
        concurrency,
        stalledInterval: this.cfg.stalledIntervalMs,
        lockDuration: this.cfg.lockDurationMs,
      },
    );
    worker.on('error', (err: Error) =>
      this.logger.error({ err, queue: q.name }, 'worker error'),
    );
    worker.on('failed', (job: Job<JobData> | undefined, err: Error) => {
      this.queueMetrics.failed(q.name);
      this.logger.warn(
        {
          err,
          queue: q.name,
          job: job?.name,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
        },
        'job attempt failed',
      );
    });
    this.workers.push(worker);
    this.logger.log({ queue: q.name, concurrency }, 'worker started');
  }

  private async process(
    job: Job<JobData>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const entry = this.handlers.get(job.name);
    if (!entry)
      throw new UnrecoverableError(`No handler for job "${job.name}"`);
    if (!job.id) throw new UnrecoverableError(`Job "${job.name}" has no id`);
    if (!signal)
      throw new Error('BullMQ did not pass an AbortSignal to the processor');
    let decoded: { payload: unknown; meta: JobMeta };
    try {
      decoded = decodeJobData(entry.def, job.data);
    } catch (e) {
      // Payload hỏng không tự lành khi retry.
      if (e instanceof JobPayloadError) throw unrecoverable(e);
      throw e;
    }
    const { payload, meta } = decoded;
    const jobId = job.id;
    const handle = () =>
      entry.instance.handle({
        payload,
        meta,
        jobId,
        // attemptsMade chỉ tăng khi một lần chạy kết thúc, nên lần đang chạy = attemptsMade + 1.
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? this.cfg.attempts,
        signal,
        log: new Logger(`job:${job.name}`),
      });
    // Span của job là con của traceparent trong meta (request gốc, xuyên cả outbox); traceId của
    // span đó vào context để log của handler mang cùng trace.
    const run = () =>
      withRemoteParent(meta.traceparent, `job ${job.name}`, async () => {
        this.ctx.setTraceId(currentTraceId());
        // Spec SP3 §5.2: kiểm BÊN TRONG OrgScope (meta.orgId), trước handler. Job đã bắt đầu thì chạy hết.
        if (await this.skippedForInactiveOrg(entry.def, job, meta)) return;
        await handle();
      });
    // orgId không đặt ở đây: OrgScope.run validate, chuẩn hoá rồi mới đặt vào RequestContext.
    const aborted = (cause?: unknown) =>
      new Error(
        `Job "${job.name}" aborted before completion: ${String(signal.reason)}`,
        { cause },
      );
    try {
      await this.ctx.run(
        { requestId: meta.requestId, traceparent: meta.traceparent, jobId },
        () => (meta.orgId ? this.orgScope.run(meta.orgId, run) : run()),
      );
    } catch (e) {
      // Dữ liệu sai mà handler phát hiện (ví dụ payload event trong outbox) cũng không tự lành khi retry.
      if (e instanceof JobPayloadError) throw unrecoverable(e);
      // `signal.throwIfAborted()` ném chính `reason` (chuỗi của cancelAllJobs), không phải Error.
      if (signal.aborted && !(e instanceof Error)) throw aborted(e);
      throw e;
    }
    // Handler dừng sớm vì abort mà vẫn return bình thường thì BullMQ sẽ ghi `completed` và việc
    // dở dang mất âm thầm. Lỗi thường (không Unrecoverable) để job được retry theo backoff.
    if (signal.aborted) throw aborted();
  }

  /** `true` = job kết thúc `completed` mà không gọi handler. Gate ném (lỗi hạ tầng) → lỗi của job, BullMQ retry. */
  private async skippedForInactiveOrg(
    def: JobDef,
    job: Job<JobData>,
    meta: JobMeta,
  ): Promise<boolean> {
    if (!meta.orgId || def.onInactiveOrg === 'run' || !this.orgGate)
      return false;
    const activity = await this.orgGate.check();
    switch (activity.kind) {
      case 'ACTIVE':
        return false;
      case 'DELETED':
        this.recordSkip(job, job.timestamp > activity.deletedAt.getTime());
        return true;
      case 'GONE':
        this.recordSkip(job, true);
        return true;
      default: {
        const unknown: never = activity;
        throw new Error(`unknown org activity ${JSON.stringify(unknown)}`);
      }
    }
  }

  /**
   * R4A-N4: org đã mất, hoặc job được enqueue SAU khi org bị xoá mềm, gần như chắc chắn là job phản ứng với vòng đời
   * org mà khai thiếu `onInactiveOrg: 'run'` → WARN. Job enqueue trước khi xoá mềm bị bỏ là hành vi mong đợi → INFO.
   */
  private recordSkip(job: Job<JobData>, suspicious: boolean): void {
    this.queueMetrics.skipped('org_inactive');
    const fields = {
      event: suspicious
        ? 'job_skipped_org_inactive_after_delete'
        : 'job_skipped_org_inactive',
      job: job.name,
      jobId: job.id,
    };
    if (suspicious)
      this.logger.warn(
        fields,
        "tenant job skipped after its organization was deleted; a job reacting to the org lifecycle must declare onInactiveOrg: 'run'",
      );
    else
      this.logger.log(fields, 'tenant job skipped: organization is not active');
  }

  /**
   * Chờ job đang chạy xong tối đa `shutdownTimeoutMs`; quá hạn thì abort signal của chúng và
   * chờ thêm tối đa `shutdownAbortGraceMs`. Không dùng `worker.close(true)`: khi `close()` đang
   * chạy, BullMQ trả lại đúng promise đó nên force không có tác dụng. Không `disconnect()` khi
   * job còn chạy: BullMQ sẽ retry `moveToCompleted` vô hạn trên connection đã đóng.
   * Gọi lại (kể cả song song) nhận cùng một promise.
   */
  closeAll(): Promise<void> {
    this.closing ??= this.closeWorkers(this.workers.splice(0));
    return this.closing;
  }

  private async closeWorkers(workers: Worker<JobData>[]): Promise<void> {
    if (workers.length === 0) return;
    const closing = Promise.all(workers.map((w) => w.close()));
    if ((await within(closing, this.cfg.shutdownTimeoutMs)) !== 'timeout')
      return;
    this.logger.error(
      { timeoutMs: this.cfg.shutdownTimeoutMs },
      'jobs still running at shutdown timeout; aborting them',
    );
    for (const w of workers) w.cancelAllJobs(SHUTDOWN_ABORT_REASON);
    if ((await within(closing, this.cfg.shutdownAbortGraceMs)) !== 'timeout')
      return;
    this.logger.error(
      { graceMs: this.cfg.shutdownAbortGraceMs },
      'jobs ignored the abort signal; abandoning workers, the process must exit',
    );
  }

  /** Chạy trước mọi `onApplicationShutdown`, nên job đang chạy vẫn còn DB và Redis. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.closeAll();
  }
}
