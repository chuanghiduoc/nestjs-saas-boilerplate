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
import { JobQueue } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { DispatchEventJob } from './outbox.jobs.js';

export const OUTBOX_RELAY_HOOKS = Symbol('core.outboxRelayHooks');
/** Chỉ cho test: chèn lỗi giữa lúc enqueue xong và lúc đánh dấu published. */
export type OutboxRelayHooks = { afterEnqueue?: () => Promise<void> };

const ClaimedRow = z.object({
  id: z.string(),
  org_id: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
});
type Claimed = z.infer<typeof ClaimedRow>;

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
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
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

  /** Vòng poll: lô đầy thì chạy tiếp ngay, không thì chờ `pollIntervalMs`. Gọi lại khi đang chạy là lỗi. */
  start(): void {
    if (this.loop) throw new Error('OutboxRelay is already running');
    const loop = {};
    this.loop = loop;
    const tick = async (): Promise<void> => {
      if (this.loop !== loop) return;
      let full = false;
      this.running = this.runOnce()
        .then((n) => {
          full = n === this.cfg.batchSize;
        })
        .catch((err: unknown) =>
          this.logger.error({ err }, 'outbox relay iteration failed'),
        );
      await this.running;
      if (this.loop === loop)
        this.timer = setTimeout(
          () => void tick(),
          full ? 0 : this.cfg.pollIntervalMs,
        );
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  /** Dừng vòng poll: huỷ timer và chờ lô đang chạy (transaction claim) kết thúc. */
  async stop(): Promise<void> {
    this.loop = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Dừng trước `onApplicationShutdown` để lô đang chạy vẫn còn Redis (JobQueue) và DB. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Chạy liên tục tới khi không còn dòng chưa gửi. Trả về tổng số dòng đã gửi. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.runOnce();
      total += n;
      if (n < this.cfg.batchSize) return total;
    }
  }

  async runOnce(): Promise<number> {
    let claimed: string[] = [];
    try {
      return await this.relayDb.transaction(async (tx) => {
        const rows = (
          await tx.execute(
            `SELECT id::text AS id, org_id::text AS org_id, headers FROM outbox_events
             WHERE published_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
            [this.cfg.batchSize],
          )
        ).map((r) => ClaimedRow.parse(r));
        if (rows.length === 0) return 0;
        claimed = rows.map((r) => r.id);
        await this.queue.enqueueMany(
          rows.map((r) => ({
            job: DispatchEventJob,
            payload: { outboxId: r.id },
            opts: { jobId: dispatchJobId(r.id), meta: this.metaOf(r) },
          })),
        );
        await this.hooks.afterEnqueue?.();
        await tx.execute(
          `UPDATE outbox_events SET published_at = now(), updated_at = now() WHERE id IN (?)`,
          [claimed],
        );
        return rows.length;
      });
    } catch (err) {
      if (claimed.length) await this.recordFailedAttempt(claimed);
      throw err;
    }
  }

  /** Job chạy trong ngữ cảnh của request gốc (correlation/trace) và OrgScope của event. */
  private metaOf(r: Claimed) {
    return {
      requestId: r.headers.correlationId,
      traceparent: r.headers.traceparent,
      orgId: r.org_id ?? undefined,
    };
  }

  /** Lỗi khi ghi số lần thử được log riêng; lỗi gốc của lô vẫn được ném ra cho caller. */
  private async recordFailedAttempt(ids: string[]): Promise<void> {
    try {
      const rows = await this.relayDb.execute<{
        id: string;
        publish_attempts: number;
      }>(
        `UPDATE outbox_events SET publish_attempts = publish_attempts + 1, updated_at = now()
         WHERE id IN (?) AND published_at IS NULL RETURNING id::text AS id, publish_attempts`,
        [ids],
      );
      for (const r of rows) {
        if (r.publish_attempts >= this.cfg.attemptsAlertThreshold)
          this.logger.error(
            { outboxId: r.id, attempts: r.publish_attempts },
            'outbox event keeps failing to publish',
          );
      }
    } catch (err) {
      this.logger.error(
        { err, outboxIds: ids },
        'failed to record outbox publish attempt',
      );
    }
  }
}
