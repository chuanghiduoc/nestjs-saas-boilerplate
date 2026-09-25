import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { OutboxWriter } from '../outbox/index.js';
import type { EventDef } from './event-definition.js';
import type { EventActor } from './envelope.js';

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

  async publish<S extends z.ZodType>(
    def: EventDef<S>,
    input: {
      data: z.infer<S>;
      aggregate: { type: string; id: string; version: number };
      actor: EventActor;
      causationId?: string;
    },
  ): Promise<string> {
    const data = def.schema.parse(input.data);
    const id = v7();
    const traceparent = this.ctx.traceparent();
    await this.outbox.append({
      eventId: id,
      type: def.type,
      version: def.version,
      orgId: this.ctx.orgId() ?? null,
      aggregate: input.aggregate,
      payload: data,
      headers: {
        actorType: input.actor.type,
        actorId: input.actor.id,
        correlationId: this.ctx.requestId(),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        ...(traceparent ? { traceparent } : {}),
      },
    });
    return id;
  }
}
