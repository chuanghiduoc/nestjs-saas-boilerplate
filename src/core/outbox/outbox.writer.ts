import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
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
 * Những gì relay chuyển thành meta của job (`JobMeta`: orgId là `z.uuid()`) phải hợp lệ ngay lúc
 * ghi: Postgres nhận UUID mà zod từ chối (sai variant), và một dòng như vậy sẽ bị relay park.
 */
const RelayedFields = z.object({
  orgId: z.uuid().nullable(),
  headers: z.record(z.string(), z.string()),
});

/**
 * Ghi event vào outbox trong transaction hiện tại (`Db` gắn đúng connection/session của
 * UnitOfWork): commit thì event tồn tại, rollback (kể cả khi UnitOfWork chạy lại fn vì
 * 40001/40P01) thì biến mất cùng dữ liệu nghiệp vụ. `app_user` chỉ có quyền INSERT.
 *
 * Org (spec SP1 §5.4): trong một org, event phải thuộc đúng org của context — org khác hoặc `null`
 * đều bị từ chối, vì relay/dispatch sẽ chạy subscriber dưới RLS của org ghi trên dòng. Ngoài org
 * (hệ thống: relay, reconcile, SafeEnqueue của job hệ thống) thì `orgId` của event được giữ nguyên.
 */
@Injectable()
export class OutboxWriter {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly ctx: RequestContext,
  ) {}

  async append(e: NewOutboxEvent): Promise<void> {
    if (!this.uow.inTransaction())
      throw new Error(
        'OutboxWriter.append must be called inside UnitOfWork.run',
      );
    const checked = RelayedFields.safeParse({
      orgId: e.orgId,
      headers: e.headers,
    });
    if (!checked.success)
      throw new Error(
        `Invalid outbox event "${e.type}": ${z.prettifyError(checked.error)}`,
      );
    const contextOrg = this.ctx.orgId();
    if (contextOrg !== undefined && e.orgId?.toLowerCase() !== contextOrg)
      throw new Error(
        `Outbox event "${e.type}" org ${e.orgId ?? 'none'} does not match the context org ${contextOrg}; an event written inside an org always belongs to that org`,
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
