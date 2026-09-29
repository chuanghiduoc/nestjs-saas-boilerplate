import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  AUDITED_EVENTS,
  EventPublisher,
  EventSubscriber,
  EventsModule,
  WEBHOOK_EVENTS,
  defineEvent,
  type EventEnvelope,
} from '../../../../src/core/events/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const Data = z.object({ k: z.string() });
const SelAudited = defineEvent({
  type: 'fixture.sel.audited',
  version: 1,
  schema: Data,
  audit: true,
  webhook: false,
});
const SelHooked = defineEvent({
  type: 'fixture.sel.hooked',
  version: 1,
  schema: Data,
  audit: true,
  webhook: true,
});
const SelSilent = defineEvent({
  type: 'fixture.sel.silent',
  version: 1,
  schema: Data,
  audit: false,
  webhook: false,
});

const got: { consumer: string; type: string; k: string }[] = [];
const record = (consumer: string, e: EventEnvelope<unknown>) =>
  got.push({ consumer, type: e.type, k: Data.parse(e.data).k });
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.audit', events: AUDITED_EVENTS })
class AuditSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.audit', e);
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.hooks', events: WEBHOOK_EVENTS })
class HookSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.hooks', e);
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.single', event: SelSilent })
class SingleSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.single', e);
  }
}
@Module({ providers: [AuditSub, HookSub, SingleSub] })
class Subs {}

/** Thời gian chờ thêm sau khi đủ số lần giao, để bắt lần giao thừa (nếu có). */
const SETTLE_MS = 300;
const until = async (pred: () => boolean, ms = 15_000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('selector subscribers through the real outbox pipeline (spec SP6 §5.3, C-2, C-3, C-4)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      Subs,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  const publishIn = (
    orgId: string | null,
    fn: (p: EventPublisher) => Promise<unknown>,
  ) =>
    app.get(RequestContext).run({}, () => {
      const inTx = () =>
        app.get(UnitOfWork).run(() => fn(app.get(EventPublisher)));
      return orgId ? app.get(OrgScope).run(orgId, inTx) : inTx();
    });
  const input = (k: string) => ({
    data: { k },
    aggregate: { type: 'fixture', id: k, version: 1 },
    actor: { type: 'system' as const, id: 'fixture' },
  });

  it('audit gets audit:true events, webhook gets webhook:true events, the single subscriber gets only its event', async () => {
    const k = v7();
    await publishIn(v7(), async (p) => {
      await p.publish(SelAudited, input(`${k}-a`));
      await p.publish(SelHooked, input(`${k}-h`));
      await p.publish(SelSilent, input(`${k}-s`));
    });
    const mine = () => got.filter((g) => g.k.startsWith(k));
    await until(() => mine().length === 4);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(
      mine()
        .map((g) => `${g.consumer}:${g.type}`)
        .sort(),
    ).toEqual(
      [
        'fixture.sel.audit:fixture.sel.audited',
        'fixture.sel.audit:fixture.sel.hooked',
        'fixture.sel.hooks:fixture.sel.hooked',
        'fixture.sel.single:fixture.sel.silent',
      ].sort(),
    );
  });
  it('a webhook event published outside an organization is refused inside the caller transaction', async () => {
    await expect(
      publishIn(null, (p) => p.publish(SelHooked, input(v7()))),
    ).rejects.toThrow(/must be published inside an organization context/);
  });
});
