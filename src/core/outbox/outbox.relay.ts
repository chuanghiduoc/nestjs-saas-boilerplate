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
  type EnqueueItem,
  type JobMeta,
} from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { DispatchEventJob } from './outbox.jobs.js';

export const OUTBOX_RELAY_HOOKS = Symbol('core.outboxRelayHooks');
/**
 * Chỉ cho test: chèn lỗi/chờ ngay sau khi claim (relay chết hoặc treo khi đang giữ lease), và
 * giữa lúc enqueue xong và lúc đánh dấu published.
 */
export type OutboxRelayHooks = {
  afterClaim?: () => Promise<void>;
  afterEnqueue?: () => Promise<void>;
};

/**
 * `id` và `lease` luôn có (biểu thức SQL); các cột còn lại được validate theo từng dòng. `lease`
 * là `claimed_until` do chính lần claim này đặt, dùng làm token sở hữu lease.
 */
const ClaimRef = z.object({ id: z.string(), lease: z.string() });
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
 * Mô hình đồng thời: claim theo lease, KHÔNG BAO GIỜ giữ transaction DB trong lúc gọi Redis
 * (ADR 0006, "No external I/O inside a DB transaction"). Mỗi bước là một câu lệnh tự commit
 * (một transaction ngầm; kysely trả connection về pool trong `finally`):
 * 1. Claim: `UPDATE … SET claimed_until = now() + lease WHERE id IN (SELECT … FOR UPDATE SKIP
 *    LOCKED)` chỉ lấy dòng chưa publish, chưa park, chưa có lease hoặc lease đã hết hạn. Hai relay
 *    không bao giờ cùng giữ lease của một dòng và không chờ khoá của nhau (không deadlock).
 * 2. Dòng hỏng (không thành được meta/job hợp lệ): `publish_attempts + 1`, bỏ lease, log error;
 *    tới `maxPublishAttempts` thì bị park (không claim nữa) chờ xử lý dead-letter. Dòng hỏng
 *    không bao giờ chặn các dòng khác.
 * 3. Enqueue ngoài mọi transaction, bị chặn bởi `enqueueTimeoutMs`.
 * 4. Đánh dấu `published_at` (`AND published_at IS NULL`: relay đến muộn là no-op).
 *
 * Lỗi cả lô (timeout/lỗi Redis, lỗi DB sau claim) không quy cho dòng nào: không tăng attempts
 * (nếu tăng, một sự cố Redis sẽ park cả dòng tốt), trả lease của chính lô này để lô sau thử lại
 * ngay, log và backoff. Relay chết/treo sau claim: dòng chờ hết lease rồi relay khác claim lại và
 * enqueue lại với cùng `jobId` (`outbox-<id>`), BullMQ bỏ qua nếu job cũ còn giữ; enqueue trễ của
 * một lô đã timeout cũng bị bỏ qua như vậy. Chống trùng cuối cùng nằm ở Inbox phía consumer (job
 * đã xong có thể đã bị xoá khỏi Redis).
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

  /** Dừng vòng poll: huỷ timer và chờ mọi lô đang chạy kết thúc (mỗi lô bị chặn bởi enqueue timeout). */
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

  private async claimAndPublish(): Promise<BatchResult> {
    const refs = (await this.claim()).map((r) => ({
      ...ClaimRef.parse(r),
      raw: r,
    }));
    const [first] = refs;
    if (!first) return { claimed: 0, published: 0, rejected: [] };
    // Một câu UPDATE dùng một `now()`, nên mọi dòng của lô có cùng lease.
    const lease = first.lease;
    if (refs.some((r) => r.lease !== lease))
      throw new Error('outbox claim returned rows with different leases');
    const ids = refs.map((r) => r.id);
    try {
      await this.hooks.afterClaim?.();
      const good: { id: string; meta: JobMeta }[] = [];
      const rejected: Rejected[] = [];
      for (const r of refs) {
        const checked = this.check(r.id, r.raw);
        if ('reason' in checked) rejected.push(checked);
        else good.push(checked);
      }
      const attempts = await this.reject(rejected, lease);
      const published = good.length ? await this.publish(good) : 0;
      return {
        claimed: refs.length,
        published,
        rejected: rejected.map((x) => ({
          ...x,
          attempts: attempts.get(x.id) ?? 0,
        })),
      };
    } catch (err) {
      await this.release(ids, lease);
      throw err;
    }
  }

  /** Một câu lệnh tự commit: không có transaction nào còn mở sau khi nó trả về. */
  private claim(): Promise<Record<string, unknown>[]> {
    return this.relayDb.execute(
      `UPDATE outbox_events
       SET claimed_until = now() + ?::int * interval '1 millisecond', updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE published_at IS NULL AND publish_attempts < ?
           AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING id::text AS id, org_id::text AS org_id, headers, claimed_until::text AS lease`,
      [this.cfg.claimLeaseMs, this.cfg.maxPublishAttempts, this.cfg.batchSize],
    );
  }

  /**
   * Dòng hỏng: tăng attempts và bỏ lease. Chỉ khi lô này còn giữ lease, để một relay có lease đã
   * hết hạn (dòng đã bị claim lại) không tăng attempts lần hai.
   */
  private async reject(
    rejected: Rejected[],
    lease: string,
  ): Promise<Map<string, number>> {
    if (!rejected.length) return new Map();
    const rows = await this.relayDb.execute<{
      id: string;
      publish_attempts: number;
    }>(
      `UPDATE outbox_events
       SET publish_attempts = publish_attempts + 1, claimed_until = NULL, updated_at = now()
       WHERE id IN (?) AND published_at IS NULL AND claimed_until = ?::timestamptz
       RETURNING id::text AS id, publish_attempts`,
      [rejected.map((x) => x.id), lease],
    );
    return new Map(rows.map((x) => [x.id, x.publish_attempts]));
  }

  /**
   * Enqueue rồi đánh dấu published. Đánh dấu không cần còn lease: job đã vào Redis thì dòng đã
   * được publish, bất kể relay nào đang giữ lease. Trả về số dòng chính lô này đánh dấu.
   */
  private async publish(
    good: { id: string; meta: JobMeta }[],
  ): Promise<number> {
    await this.enqueueWithin(
      good.map((g) => ({
        job: DispatchEventJob,
        payload: { outboxId: g.id },
        opts: { jobId: dispatchJobId(g.id), meta: g.meta },
      })),
    );
    await this.hooks.afterEnqueue?.();
    const marked = await this.relayDb.execute(
      `UPDATE outbox_events SET published_at = now(), claimed_until = NULL, updated_at = now()
       WHERE id IN (?) AND published_at IS NULL
       RETURNING id`,
      [good.map((g) => g.id)],
    );
    return marked.length;
  }

  /**
   * `enqueueMany` bị chặn bởi `enqueueTimeoutMs`: BullMQ không có timeout/abort cho `addBulk`, và
   * `Queue` mới tạo chờ Redis 'ready' không giới hạn. Quá hạn thì lô thất bại; lời gọi cũ vẫn có
   * thể thành công muộn, khi đó job trùng `jobId` với lần gửi lại nên BullMQ bỏ qua, và lô đã thất
   * bại không bao giờ đánh dấu published.
   */
  private async enqueueWithin(items: EnqueueItem[]): Promise<void> {
    const enqueue = this.queue.enqueueMany(items);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.cfg.enqueueTimeoutMs);
    });
    try {
      if ((await Promise.race([enqueue, timeout])) !== 'timeout') return;
    } finally {
      clearTimeout(timer);
    }
    void enqueue.then(
      () =>
        this.logger.warn(
          { jobs: items.length },
          'outbox enqueue completed after its timeout; the retried jobs are deduplicated by jobId',
        ),
      (err: unknown) =>
        this.logger.warn({ err }, 'outbox enqueue failed after its timeout'),
    );
    throw new Error(
      `outbox enqueue timed out after ${this.cfg.enqueueTimeoutMs}ms`,
    );
  }

  /**
   * Lô thất bại: trả lease để lô sau thử lại ngay thay vì chờ hết hạn. Chỉ trả lease của chính lô
   * này (relay khác có thể đã claim lại dòng sau khi lease hết hạn). Trả lease lỗi thì chỉ log:
   * lease tự hết hạn, và lỗi gốc của lô mới là lỗi cần báo.
   */
  private async release(ids: string[], lease: string): Promise<void> {
    try {
      await this.relayDb.execute(
        `UPDATE outbox_events SET claimed_until = NULL, updated_at = now()
         WHERE id IN (?) AND published_at IS NULL AND claimed_until = ?::timestamptz`,
        [ids, lease],
      );
    } catch (err) {
      this.logger.error(
        { err, rows: ids.length },
        'outbox relay could not release its claim; rows are retried when the lease expires',
      );
    }
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
