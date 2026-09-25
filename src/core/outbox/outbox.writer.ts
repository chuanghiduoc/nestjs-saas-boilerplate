import { Injectable } from '@nestjs/common';
import { Db, UnitOfWork } from '../database/index.js';

export type NewOutboxEvent = {
  eventId: string;
  type: string;
  version: number;
  orgId: string | null;
  aggregate: { type: string; id: string; version: number };
  payload: unknown;
  headers: Record<string, string>;
};

/**
 * Ghi event vào outbox trong transaction hiện tại (`Db` gắn đúng connection/session của
 * UnitOfWork): commit thì event tồn tại, rollback (kể cả khi UnitOfWork chạy lại fn vì
 * 40001/40P01) thì biến mất cùng dữ liệu nghiệp vụ. `app_user` chỉ có quyền INSERT.
 */
@Injectable()
export class OutboxWriter {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
  ) {}

  async append(e: NewOutboxEvent): Promise<void> {
    if (!this.uow.inTransaction())
      throw new Error(
        'OutboxWriter.append must be called inside UnitOfWork.run',
      );
    await this.db.execute(
      `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      [
        e.eventId,
        e.type,
        e.version,
        e.orgId,
        e.aggregate.type,
        e.aggregate.id,
        e.aggregate.version,
        JSON.stringify(e.payload),
        JSON.stringify(e.headers),
      ],
    );
  }
}
