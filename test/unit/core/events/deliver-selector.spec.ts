import { Injectable, Logger, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { v7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { UnitOfWork } from '../../../../src/core/database/index.js';
import {
  AUDITED_EVENTS,
  EventSubscriber,
  SubscriberRegistry,
  WEBHOOK_EVENTS,
  defineEvent,
  type EventEnvelope,
  type EventSelector,
} from '../../../../src/core/events/index.js';
import {
  DeliverEventHandler,
  type OutboxReader,
  type OutboxRow,
} from '../../../../src/core/events/event-dispatch.handlers.js';
import type { Inbox } from '../../../../src/core/outbox/index.js';
import {
  JobPayloadError,
  type JobContext,
} from '../../../../src/core/queue/index.js';

const Audited = defineEvent({
  type: 'unit.sel.audited',
  version: 1,
  schema: z.object({ n: z.number() }),
  audit: true,
  webhook: false,
});
const Silent = defineEvent({
  type: 'unit.sel.silent',
  version: 1,
  schema: z.object({}),
  audit: false,
  webhook: false,
});

const seen: { consumer: string; type: string; data: unknown }[] = [];
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.audit', events: AUDITED_EVENTS })
class AuditAll {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.audit', type: e.type, data: e.data });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.hooks', events: WEBHOOK_EVENTS })
class HookAll {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.hooks', type: e.type, data: e.data });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.single', event: Silent })
class OnlySilent {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.single', type: e.type, data: e.data });
  }
}
const Rogue: EventSelector = { name: 'audit', matches: () => true };
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.rogue', events: Rogue })
class RogueSelector {
  async handle() {}
}
/**
 * Định nghĩa SAU các class subscriber trong file (C-2): mọi `defineEvent` chạy lúc import, trước `onModuleInit`, nên
 * subscriber bộ chọn vẫn nhận nó.
 */
const Hooked = defineEvent({
  type: 'unit.sel.hooked',
  version: 1,
  schema: z.object({}),
  audit: true,
  webhook: true,
});

async function boot(providers: Type<unknown>[]): Promise<SubscriberRegistry> {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [SubscriberRegistry, ...providers],
  }).compile();
  try {
    await ref.init();
    return ref.get(SubscriberRegistry);
  } finally {
    await ref.close();
  }
}
const row = (type: string, version: number, payload: unknown): OutboxRow => ({
  id: '42',
  event_id: v7(),
  type,
  version,
  org_id: null,
  aggregate_type: 'unit',
  aggregate_id: 'u1',
  aggregate_version: '1',
  payload,
  headers: { actorType: 'system', actorId: 'unit', correlationId: 'c-unit' },
  occurred_at: new Date(),
});
function deliverer(reg: SubscriberRegistry, r: OutboxRow) {
  const reader = { load: () => Promise.resolve(r) } as Pick<
    OutboxReader,
    'load'
  > as OutboxReader;
  const inbox = {
    once: async (_c: string, _id: string, fn: () => Promise<void>) => {
      await fn();
      return 'processed' as const;
    },
  } as Pick<Inbox, 'once'> as Inbox;
  const uow = { run: <T>(fn: () => Promise<T>) => fn() } as Pick<
    UnitOfWork,
    'run'
  > as UnitOfWork;
  return new DeliverEventHandler(reader, reg, inbox, uow);
}
const ctx = (
  consumer: string,
): JobContext<{ consumer: string; outboxId: string }> => ({
  payload: { consumer, outboxId: '42' },
  meta: {},
  jobId: `deliver-${consumer}-42`,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('unit'),
});

describe('selector subscribers (spec SP6 §5.3 core/events, C-2, C-3, C-4)', () => {
  it('index a selector subscriber under every matching def, including one defined later in the import tree (C-2)', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    const consumers = (type: string) =>
      reg
        .forEvent(type, 1)
        .map((e) => e.meta.consumer)
        .sort();
    expect(consumers(Audited.type)).toEqual(['unit.sel.audit']);
    expect(consumers(Hooked.type)).toEqual([
      'unit.sel.audit',
      'unit.sel.hooks',
    ]);
    expect(consumers(Silent.type)).toEqual(['unit.sel.single']);
  });
  it('a selector other than AUDITED_EVENTS / WEBHOOK_EVENTS fails boot', async () => {
    await expect(boot([RogueSelector])).rejects.toThrow(
      /selector must be AUDITED_EVENTS or WEBHOOK_EVENTS/,
    );
  });
  it('an event defined after the registry was built is refused at dispatch, not silently skipped', async () => {
    const reg = await boot([AuditAll]);
    defineEvent({
      type: 'unit.sel.late',
      version: 1,
      schema: z.object({}),
      audit: true,
      webhook: false,
    });
    expect(() => reg.forEvent('unit.sel.late', 1)).toThrow(
      /defined after the subscriber registry was built/,
    );
  });
  it('deliver hands a selector subscriber the envelope parsed with the schema of the row def', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    seen.length = 0;
    await deliverer(reg, row(Audited.type, 1, { n: 7 })).handle(
      ctx('unit.sel.audit'),
    );
    expect(seen).toEqual([
      { consumer: 'unit.sel.audit', type: Audited.type, data: { n: 7 } },
    ]);
  });
  it('deliver of a row whose type is outside the subscriber set is an error (C-3)', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    await expect(
      deliverer(reg, row(Silent.type, 1, {})).handle(ctx('unit.sel.audit')),
    ).rejects.toThrow(
      /Subscriber "unit\.sel\.audit" does not handle unit\.sel\.silent@1/,
    );
    await expect(
      deliverer(reg, row(Audited.type, 1, { n: 1 })).handle(
        ctx('unit.sel.hooks'),
      ),
    ).rejects.toThrow(/does not handle unit\.sel\.audited@1/);
  });
  it('deliver of a payload that breaks the schema is a JobPayloadError (C-3)', async () => {
    const reg = await boot([AuditAll]);
    await expect(
      deliverer(reg, row(Audited.type, 1, { n: 'x' })).handle(
        ctx('unit.sel.audit'),
      ),
    ).rejects.toBeInstanceOf(JobPayloadError);
  });
  it('a single-event subscriber still gets exactly its event and nothing else (C-4)', async () => {
    const reg = await boot([OnlySilent]);
    seen.length = 0;
    await deliverer(reg, row(Silent.type, 1, {})).handle(
      ctx('unit.sel.single'),
    );
    expect(seen).toEqual([
      { consumer: 'unit.sel.single', type: Silent.type, data: {} },
    ]);
    await expect(
      deliverer(reg, row(Audited.type, 1, { n: 1 })).handle(
        ctx('unit.sel.single'),
      ),
    ).rejects.toThrow(/does not handle/);
  });
});
