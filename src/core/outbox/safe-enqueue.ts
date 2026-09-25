import { Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { UnitOfWork } from '../database/index.js';
import {
  JobPayloadError,
  JobQueue,
  encodeJobData,
  type EnqueueOpts,
  type JobDef,
} from '../queue/index.js';
import { DEFERRED_JOB_EVENT_TYPE } from './outbox.jobs.js';
import { OutboxWriter } from './outbox.writer.js';

/**
 * Enqueue không mất job và không chạy job của transaction bị rollback:
 * - Trong transaction: LUÔN ghi outbox (`core.job.deferred`), job chỉ được gửi sau commit.
 * - Ngoài transaction: gửi thẳng Redis; lỗi (không phải payload sai) thì ghi outbox.
 * `jobId` sinh một lần và dùng cho cả hai đường, nên nếu Redis đã nhận job nhưng báo lỗi
 * (timeout) rồi outbox gửi lại, BullMQ vẫn chỉ giữ một job.
 */
@Injectable()
export class SafeEnqueue {
  private readonly logger = new Logger(SafeEnqueue.name);

  constructor(
    private readonly queue: JobQueue,
    private readonly outbox: OutboxWriter,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
  ) {}

  async enqueue<S extends z.ZodType>(
    job: JobDef<S>,
    payload: z.infer<S>,
    opts: EnqueueOpts = {},
  ): Promise<void> {
    // Validate sớm: payload sai không được hoãn vào outbox để rồi hỏng lúc relay.
    encodeJobData(job, payload, {});
    const jobId = opts.jobId ?? v7();
    if (this.uow.inTransaction()) return this.defer(job, payload, jobId, opts);
    try {
      await this.queue.enqueueDynamic(job, payload, { ...opts, jobId });
    } catch (err) {
      if (err instanceof JobPayloadError) throw err;
      this.logger.warn(
        { err, job: job.name, jobId },
        'direct enqueue failed; deferring via outbox',
      );
      await this.uow.run(() => this.defer(job, payload, jobId, opts));
    }
  }

  private defer(
    job: JobDef,
    payload: unknown,
    jobId: string,
    opts: EnqueueOpts,
  ): Promise<void> {
    const traceparent = this.ctx.traceparent();
    return this.outbox.append({
      eventId: v7(),
      type: DEFERRED_JOB_EVENT_TYPE,
      version: 1,
      orgId: this.ctx.orgId() ?? null,
      aggregate: { type: 'job', id: jobId, version: 1 },
      payload: { job: job.name, payload, jobId, delayMs: opts.delayMs },
      headers: {
        correlationId: this.ctx.requestId(),
        ...(traceparent ? { traceparent } : {}),
      },
    });
  }
}
