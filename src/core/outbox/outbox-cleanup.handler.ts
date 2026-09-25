import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { RelayDb } from '../database/index.js';
import { JobHandler, type JobContext } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { OutboxCleanupJob } from './outbox.jobs.js';

/** `published_at < ...` loại sẵn dòng chưa publish và dòng bị park (published_at NULL). */
const DELETE_PUBLISHED_OUTBOX = `WITH victim AS (
    SELECT id FROM outbox_events WHERE published_at < now() - make_interval(days => ?) ORDER BY published_at LIMIT ?)
  , d AS (DELETE FROM outbox_events o USING victim v WHERE o.id = v.id RETURNING 1)
  SELECT count(*)::int AS n FROM d`;
const DELETE_EXPIRED_INBOX = `WITH victim AS (
    SELECT consumer, event_id FROM processed_events WHERE processed_at < now() - make_interval(days => ?) ORDER BY processed_at LIMIT ?)
  , d AS (DELETE FROM processed_events p USING victim v WHERE p.consumer = v.consumer AND p.event_id = v.event_id RETURNING 1)
  SELECT count(*)::int AS n FROM d`;

/**
 * Dọn outbox/inbox theo lô trên connection `relay` (app_relay có DELETE trên hai bảng). Mỗi câu
 * lệnh là một transaction ngắn xoá tối đa `cleanupBatchSize` dòng (dùng index `published_at` /
 * `processed_at`), mỗi bảng tối đa `cleanupMaxBatches` câu mỗi lần chạy, nên không giữ khoá lâu
 * và một lần chạy luôn có giới hạn. Không đụng dòng relay đang claim (chỉ dòng chưa publish).
 * Hai lần chạy song song an toàn: câu sau chờ khoá dòng rồi thấy dòng đã mất và xoá ít hơn.
 */
@Injectable()
@JobHandler(OutboxCleanupJob)
export class OutboxCleanupHandler {
  private readonly logger = new Logger(OutboxCleanupHandler.name);

  constructor(
    private readonly relayDb: RelayDb,
    @Inject(outboxConfig.KEY)
    private readonly cfg: ConfigOf<typeof outboxConfig>,
  ) {}

  async handle(
    ctx?: JobContext<unknown>,
  ): Promise<{ outboxDeleted: number; inboxDeleted: number }> {
    const outboxDeleted = await this.deleteInBatches(
      DELETE_PUBLISHED_OUTBOX,
      this.cfg.retentionDays,
      ctx?.signal,
    );
    const inboxDeleted = await this.deleteInBatches(
      DELETE_EXPIRED_INBOX,
      this.cfg.inboxRetentionDays,
      ctx?.signal,
    );
    this.logger.log({ outboxDeleted, inboxDeleted }, 'outbox cleanup done');
    return { outboxDeleted, inboxDeleted };
  }

  private async deleteInBatches(
    sql: string,
    days: number,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.cfg.cleanupMaxBatches; i++) {
      signal?.throwIfAborted();
      const [row] = await this.relayDb.execute<{ n: number }>(sql, [
        days,
        this.cfg.cleanupBatchSize,
      ]);
      if (!row) throw new Error('cleanup statement returned no count row');
      total += row.n;
      if (row.n < this.cfg.cleanupBatchSize) break;
    }
    return total;
  }
}
