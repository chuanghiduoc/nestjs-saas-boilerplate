import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { type ConfigOf, appConfig } from '../config/index.js';
import { RelayDb } from '../database/index.js';
import {
  JobPayloadError,
  JobQueue,
  encodeJobData,
  type JobMeta,
} from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { DispatchEventJob } from './outbox.jobs.js';

export const OUTBOX_RELAY_HOOKS = Symbol('core.outboxRelayHooks');
/** Chỉ cho test: chèn lỗi/chờ giữa lúc enqueue xong và lúc đánh dấu published. */
export type OutboxRelayHooks = { afterEnqueue?: () => Promise<void> };

/** `id` luôn có (`id::text`); các cột còn lại được validate theo từng dòng. */
const RowId = z.object({ id: z.string() });
const ClaimedRow = z.object({
  id: z.string(),
  org_id: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
});
type Claimed = z.infer<typeof ClaimedRow>;
type Rejected = { id: string; reason: string };
type BatchResult = {
  claimed: number;
  published: number;
  rejected: (Rejected & { attempts: number })[];
};

/** BullMQ cấm `:` trong jobId; id outbox là BIGINT nên jobId luôn hợp lệ và cố định theo dòng. */
const dispatchJobId = (outboxId: string) => `outbox-${outboxId}`;

/**
 * Đẩy dòng outbox chưa publish sang queue `events`, chạy trên connection `relay` (role
 * `app_relay`), chỉ có trong worker.
 *
 * - Nhiều relay song song: mỗi lần claim là một transaction `FOR UPDATE SKIP LOCKED`, nên hai
 *   relay không bao giờ giữ cùng một dòng và không chờ khoá của nhau (không deadlock).
 * - Crash/lỗi sau khi enqueue mà trước khi commit `published_at`: transaction rollback, dòng
 *   được gửi lại lần sau với cùng `jobId` (`outbox-<id>`) nên BullMQ bỏ qua nếu job cũ còn giữ;
 *   chống trùng cuối cùng nằm ở Inbox phía consumer (job đã xong có thể đã bị xoá khỏi Redis).
 * - Dòng hỏng (không thành được meta/job hợp lệ) bị loại khỏi lô, `publish_attempts + 1`, log
 *   error; tới `maxPublishAttempts` thì bị park (không claim nữa) chờ xử lý dead-letter. Dòng
 *   hỏng không bao giờ chặn các dòng khác. Lỗi cả lô (Redis/DB) không quy cho dòng nào: không
 *   tăng attempts (nếu tăng, một sự cố Redis sẽ park cả dòng tốt), chỉ log và backoff.
 * - Khoá dòng được giữ trong lúc gọi Redis. `statement_timeout` KHÔNG áp dụng khi session đang
 *   idle trong transaction; giới hạn thật là `commandTimeout`/`maxRetriesPerRequest` của ioredis,
 *   và chốt chặn cuối là `idle_in_transaction_session_timeout` của role `app_relay` (đặt trong
 *   docker/postgres/init; production phải đặt tương đương).
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  /** Mọi lô đang chạy (vòng poll lẫn `drain`/`runOnce` gọi tay); `stop()` chờ hết. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Định danh vòng poll hiện tại; tick của vòng cũ (start lại khi chưa chờ stop) tự thoát. */
  private loop?: object;

  constructor(
    private readonly relayDb: RelayDb,
    private readonly queue: JobQueue,
    @Inject(outboxConfig.KEY)
    private readonly cfg: ConfigOf<typeof outboxConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
    @Inject(OUTBOX_RELAY_HOOKS) private readonly hooks: OutboxRelayHooks,
  ) {}

  onApplicationBootstrap(): void {
    if (this.app.role === 'worker' && this.cfg.autostart) this.start();
  }

  /**
   * Vòng poll: lô đầy thì chạy tiếp ngay, lô thiếu thì chờ `pollIntervalMs`, lô lỗi thì chờ
   * `pollIntervalMs * 2^n` (tối đa `errorBackoffMaxMs`). Gọi lại khi đang chạy là lỗi.
   */
  start(): void {
    if (this.loop) throw new Error('OutboxRelay is already running');
    const loop = {};
    this.loop = loop;
    let failures = 0;
    const tick = async (): Promise<void> => {
      if (this.loop !== loop) return;
      let delayMs: number;
      try {
        const r = await this.batch();
        failures = 0;
        delayMs =
          r.claimed === this.cfg.batchSize ? 0 : this.cfg.pollIntervalMs;
      } catch (err) {
        failures++;
        delayMs = Math.min(
          this.cfg.pollIntervalMs * 2 ** failures,
          this.cfg.errorBackoffMaxMs,
        );
        this.logger.error(
          { err, failures, retryInMs: delayMs },
          'outbox relay iteration failed',
        );
      }
      if (this.loop === loop)
        this.timer = setTimeout(() => void tick(), delayMs);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  /** Dừng vòng poll: huỷ timer và chờ mọi lô đang chạy (transaction claim) kết thúc. */
  async stop(): Promise<void> {
    this.loop = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.inflight);
  }

  /** Dừng trước `onApplicationShutdown` để lô đang chạy vẫn còn Redis (JobQueue) và DB. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Chạy liên tục tới khi không còn dòng claim được. Trả về tổng số dòng đã gửi. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.batch();
      total += r.published;
      if (r.claimed < this.cfg.batchSize) return total;
    }
  }

  /** Một lô. Trả về số dòng đã gửi (không tính dòng bị loại). */
  async runOnce(): Promise<number> {
    return (await this.batch()).published;
  }

  private batch(): Promise<BatchResult> {
    const p = this.claimAndPublish().then((r) => {
      this.logRejected(r.rejected);
      return r;
    });
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    // Nhánh riêng chỉ để xoá khỏi tập (có cả onRejected nên không tạo unhandled rejection);
    // lỗi vẫn tới caller qua `p`.
    p.then(done, done);
    return p;
  }

  private claimAndPublish(): Promise<BatchResult> {
    return this.relayDb.transaction(async (tx) => {
      const raw = await tx.execute(
        `SELECT id::text AS id, org_id::text AS org_id, headers FROM outbox_events
         WHERE published_at IS NULL AND publish_attempts < ?
         ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [this.cfg.maxPublishAttempts, this.cfg.batchSize],
      );
      const good: { id: string; meta: JobMeta }[] = [];
      const rejected: Rejected[] = [];
      for (const r of raw) {
        const checked = this.check(RowId.parse(r).id, r);
        if ('reason' in checked) rejected.push(checked);
        else good.push(checked);
      }
      let attempts = new Map<string, number>();
      if (rejected.length) {
        const rows = await tx.execute<{ id: string; publish_attempts: number }>(
          `UPDATE outbox_events SET publish_attempts = publish_attempts + 1, updated_at = now()
           WHERE id IN (?) RETURNING id::text AS id, publish_attempts`,
          [rejected.map((x) => x.id)],
        );
        attempts = new Map(rows.map((x) => [x.id, x.publish_attempts]));
      }
      if (good.length) {
        await this.queue.enqueueMany(
          good.map((g) => ({
            job: DispatchEventJob,
            payload: { outboxId: g.id },
            opts: { jobId: dispatchJobId(g.id), meta: g.meta },
          })),
        );
        await this.hooks.afterEnqueue?.();
        await tx.execute(
          `UPDATE outbox_events SET published_at = now(), updated_at = now() WHERE id IN (?)`,
          [good.map((g) => g.id)],
        );
      }
      return {
        claimed: raw.length,
        published: good.length,
        rejected: rejected.map((x) => ({
          ...x,
          attempts: attempts.get(x.id) ?? 0,
        })),
      };
    });
  }

  /** Dòng phải thành được job hợp lệ (cùng validate như `enqueueMany`), không thì bị loại. */
  private check(
    id: string,
    raw: unknown,
  ): { id: string; meta: JobMeta } | Rejected {
    const row = ClaimedRow.safeParse(raw);
    if (!row.success) return { id, reason: z.prettifyError(row.error) };
    const meta = this.metaOf(row.data);
    try {
      encodeJobData(DispatchEventJob, { outboxId: id }, meta);
    } catch (err) {
      if (err instanceof JobPayloadError) return { id, reason: err.message };
      throw err;
    }
    return { id, meta };
  }

  /** Job chạy trong ngữ cảnh của request gốc (correlation/trace) và OrgScope của event. */
  private metaOf(r: Claimed): JobMeta {
    return {
      requestId: r.headers.correlationId,
      traceparent: r.headers.traceparent,
      orgId: r.org_id ?? undefined,
    };
  }

  /** Log sau commit để số lần thử trong log khớp DB. Không log payload/headers (chỉ lý do validate). */
  private logRejected(rejected: BatchResult['rejected']): void {
    for (const r of rejected) {
      const fields = { outboxId: r.id, attempts: r.attempts, reason: r.reason };
      if (r.attempts >= this.cfg.maxPublishAttempts)
        this.logger.error(
          fields,
          'outbox event parked after max publish attempts',
        );
      else if (r.attempts >= this.cfg.attemptsAlertThreshold)
        this.logger.error(fields, 'outbox event keeps failing to publish');
      else this.logger.error(fields, 'outbox event rejected by relay');
    }
  }
}
