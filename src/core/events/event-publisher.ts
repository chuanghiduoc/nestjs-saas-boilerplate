import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { currentTraceparent } from '../observability/trace-propagation.js';
import { OutboxWriter } from '../outbox/index.js';
import { eventKey, type EventDef } from './event-definition.js';
import {
  parseEnvelope,
  type EventActor,
  type EventEnvelope,
} from './envelope.js';

/**
 * Phát integration event qua outbox, trong transaction hiện tại (ngoài `UnitOfWork.run` thì
 * `OutboxWriter` ném lỗi): commit thì event tồn tại, rollback thì biến mất cùng dữ liệu.
 *
 * Org của event LUÔN là org của `RequestContext` (không nhận từ caller), nên code không thể phát
 * event gắn nhầm sang org khác; ngoài org (actor `system`) thì `orgId = null`.
 * `correlationId` = request id hiện tại (trong subscriber: correlationId của event gốc, vì
 * WorkerHost dựng lại request id từ meta của job). `causationId` do caller truyền — subscriber
 * phát event tiếp theo thì truyền `e.id` của event đang xử lý.
 */
@Injectable()
export class EventPublisher {
  constructor(
    private readonly outbox: OutboxWriter,
    private readonly ctx: RequestContext,
  ) {}

  /**
   * `input.eventId`: id xác định trước (vd. v5 theo aggregate) cho event có thể được phát lại bởi nhiều
   * đường (after-hook + cron đối soát); kết hợp `opts.ifAbsent` để lần ghi sau là no-op. Mặc định v7.
   */
  async publish<S extends z.ZodType>(
    def: EventDef<S>,
    input: {
      data: z.infer<S>;
      aggregate: { type: string; id: string; version: number };
      actor: EventActor;
      causationId?: string;
      eventId?: string;
    },
    opts: { ifAbsent?: boolean } = {},
  ): Promise<string> {
    // Span đang active (request/job hiện tại); trace đi tiếp qua outbox → relay → dispatch → deliver.
    // OTel tắt ở process này thì giữ traceparent nhận từ upstream (meta của job).
    const traceparent = currentTraceparent() ?? this.ctx.traceparent();
    // Validate đúng envelope mà deliver sẽ parse, TRƯỚC khi ghi: lỗi của caller (actor/aggregate
    // rỗng, version âm, data sai schema) nổ ngay trong transaction của caller, không thành một
    // event đã commit mà không subscriber nào nhận được.
    const e = this.validated(def, {
      id: input.eventId ?? v7(),
      type: def.type,
      version: def.version,
      occurredAt: new Date().toISOString(),
      orgId: this.ctx.orgId() ?? null,
      actor: input.actor,
      aggregate: input.aggregate,
      correlationId: this.ctx.requestId(),
      causationId: input.causationId ?? null,
      traceparent,
      data: input.data,
    });
    if (def.webhook && e.orgId === null)
      throw new Error(
        `Event "${eventKey(def.type, def.version)}" is a webhook event and must be published inside an organization context`,
      );
    await this.outbox.append(
      {
        eventId: e.id,
        type: e.type,
        version: e.version,
        orgId: e.orgId,
        aggregate: e.aggregate,
        payload: e.data,
        headers: {
          actorType: e.actor.type,
          actorId: e.actor.id,
          correlationId: e.correlationId,
          ...(e.causationId !== null ? { causationId: e.causationId } : {}),
          ...(e.traceparent !== undefined
            ? { traceparent: e.traceparent }
            : {}),
        },
      },
      { ifAbsent: opts.ifAbsent },
    );
    return e.id;
  }

  private validated<S extends z.ZodType>(
    def: EventDef<S>,
    raw: unknown,
  ): EventEnvelope<z.infer<S>> {
    try {
      return parseEnvelope(def, raw);
    } catch (err) {
      if (err instanceof z.ZodError)
        throw new Error(
          `Invalid event "${eventKey(def.type, def.version)}": ${z.prettifyError(err)}`,
          { cause: err },
        );
      throw err;
    }
  }
}
