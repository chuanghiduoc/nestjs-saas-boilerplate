import { Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { UnitOfWork } from '../database/index.js';
import {
  JobPayloadError,
  JobQueue,
  assertEnqueueOpts,
  encodeJobData,
  type EnqueueOpts,
  type JobDef,
  type JobMeta,
} from '../queue/index.js';
import { DEFERRED_JOB_EVENT_TYPE } from './outbox.jobs.js';
import { OutboxWriter } from './outbox.writer.js';

/**
 * Enqueue không mất job và không chạy job của transaction bị rollback:
 * - Trong transaction: LUÔN ghi outbox (`core.job.deferred`), job chỉ được gửi sau commit.
 * - Ngoài transaction: gửi thẳng Redis; lỗi transport thì ghi outbox.
 * `jobId` sinh một lần và dùng cho cả hai đường, nên nếu Redis đã nhận job nhưng báo lỗi
 * (timeout) rồi outbox gửi lại, BullMQ vẫn chỉ giữ một job.
 *
 * Mọi lỗi của caller (payload, meta, jobId, delayMs) được kiểm TRƯỚC cả hai đường và ném
 * `JobPayloadError`; vì vậy lỗi còn lại từ `enqueueDynamic` là lỗi transport/Redis và mới được
 * hoãn qua outbox.
 *
 * Meta hiệu lực (`RequestContext` + `opts.meta`, giống `JobQueue`) được ghi vào `org_id` và
 * `headers` (`correlationId`, `traceparent`) của dòng outbox — đúng các cột relay/dispatch dựng
 * lại meta — nên job đi đường outbox chạy cùng org/request như job đi thẳng.
 * `delayMs` của job hoãn được tính từ lúc dispatch, không phải từ lúc gọi.
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
    const meta: JobMeta = {
      requestId: this.ctx.requestId(),
      orgId: this.ctx.orgId(),
      traceparent: this.ctx.traceparent(),
      ...opts.meta,
    };
    assertEnqueueOpts(job, opts);
    encodeJobData(job, payload, meta);
    const jobId = opts.jobId ?? v7();
    if (this.uow.inTransaction())
      return this.defer(job, payload, jobId, opts.delayMs, meta);
    try {
      await this.queue.enqueueDynamic(job, payload, { ...opts, jobId });
    } catch (err) {
      if (err instanceof JobPayloadError) throw err;
      this.logger.warn(
        { err, job: job.name, jobId },
        'direct enqueue failed; deferring via outbox',
      );
      await this.uow.run(() =>
        this.defer(job, payload, jobId, opts.delayMs, meta),
      );
    }
  }

  private defer(
    job: JobDef,
    payload: unknown,
    jobId: string,
    delayMs: number | undefined,
    meta: JobMeta,
  ): Promise<void> {
    return this.outbox.append({
      eventId: v7(),
      type: DEFERRED_JOB_EVENT_TYPE,
      version: 1,
      orgId: meta.orgId ?? null,
      aggregate: { type: 'job', id: jobId, version: 1 },
      payload: { job: job.name, payload, jobId, delayMs },
      headers: {
        ...(meta.requestId ? { correlationId: meta.requestId } : {}),
        ...(meta.traceparent ? { traceparent: meta.traceparent } : {}),
      },
    });
  }
}
