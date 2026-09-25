import { Injectable } from '@nestjs/common';
import { Db, UnitOfWork } from '../database/index.js';

/**
 * Chống xử lý trùng phía consumer. Bản ghi `(consumer, event_id)` được INSERT trong CÙNG
 * transaction với side effect. `ON CONFLICT DO NOTHING` trên PK chờ transaction khác đang giữ
 * cùng key kết thúc: nó commit thì lần này là 'duplicate', nó rollback thì lần này INSERT được.
 * Không check-then-insert, nên an toàn khi nhiều worker nhận cùng event song song.
 */
@Injectable()
export class Inbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
  ) {}

  /** Chỉ dùng cho side effect trong DB (cùng transaction). Gọi dịch vụ ngoài thì ghi ý định trong transaction rồi gọi sau khi commit, dùng eventId làm idempotency key phía provider. */
  async once(
    consumer: string,
    eventId: string,
    fn: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    if (!this.uow.inTransaction())
      throw new Error('Inbox.once must be called inside UnitOfWork.run');
    const rows = await this.db.execute<{ consumer: string }>(
      `INSERT INTO processed_events (consumer, event_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING consumer`,
      [consumer, eventId],
    );
    if (rows.length === 0) return 'duplicate';
    await fn();
    return 'processed';
  }
}
