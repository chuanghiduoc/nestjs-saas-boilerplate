import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import {
  EmailNotifications,
  NotificationsModule,
} from '../../../src/modules/notifications/index.js';
import { PurgeDeliveriesHandler } from '../../../src/modules/notifications/application/purge-deliveries.handler.js';
import { ReconcileDeliveriesHandler } from '../../../src/modules/notifications/application/reconcile-deliveries.handler.js';
// Cross-namespace rule notifications-retention-outlives-token-ttl (final review M2) needs the identity
// namespace registered for validateAllConfigs(); this app is scoped to notifications only.
import '../../../src/modules/identity/identity.config.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const COOLDOWN_SEC = 60;
const MAX_TOTAL = 3;
const cronCtx = () => ({
  payload: {},
  meta: {},
  jobId: v7(),
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('t'),
});
let app: INestApplication;
let owner: pg.Client;
const jobIds = async (id: string) =>
  (
    await owner.query(
      `SELECT payload->>'jobId' AS j FROM outbox_events WHERE type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $1 ORDER BY id`,
      [id],
    )
  ).rows.map((r) => r.j);
// CHECK email_deliveries_attempts_state_ck: chỉ PENDING mới được attempts = 0 (SENDING chỉ tới qua claim).
async function stuck(
  state: 'PENDING' | 'SENDING',
  attempts = state === 'SENDING' ? 1 : 0,
) {
  const key = `verify-email:${v7()}`;
  await app.get(EmailNotifications).request({
    template: 'verify-email',
    to: 's@example.test',
    idempotencyKey: key,
    params: { name: 'S', url: 'https://a.test/v' },
  });
  const { rows } = await owner.query(
    `UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 * 2), attempts = $3,
       state = $4, lease_owner = CASE WHEN $4 = 'SENDING' THEN gen_random_uuid() END,
       lease_until = CASE WHEN $4 = 'SENDING' THEN now() - interval '1 minute' END
     WHERE idempotency_key = $1 RETURNING public_id`,
    [key, COOLDOWN_SEC, attempts, state],
  );
  return rows[0].public_id as string;
}

beforeAll(async () => {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC', String(COOLDOWN_SEC));
  vi.stubEnv('NOTIFICATIONS_MAX_TOTAL_ATTEMPTS', String(MAX_TOTAL));
  // FB3: email_deliveries là bảng global không org-scoped; các file khác (chạy trước, cùng DB, fileParallelism:
  // false) có thể để lại hàng PENDING/SENDING cũ hơn hàng của chính test này. `findStale` sắp theo
  // last_enqueued_at LIMIT batchSize, nên batch mặc định (200) có thể không bao giờ chạm tới hàng của ta.
  // Đặt batch cực lớn để mọi hàng đang kẹt thật đều được xét, không phụ thuộc trạng thái bảng còn lại.
  vi.stubEnv('NOTIFICATIONS_RECONCILE_BATCH_SIZE', '1000000');
  app = await createTestApp([
    DatabaseModule.forRoot({ relay: false }),
    RedisModule,
    QueueModule.forRoot({ runWorkers: false }),
    OutboxModule.forRoot({ relay: false }),
    EventsModule.forRoot({ worker: false }),
    ResilienceModule,
    NotificationsModule.forWorker(),
  ]);
  const { pg: p } = getInfra();
  owner = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await app?.close();
  vi.unstubAllEnvs();
});

describe('notifications.reconcile-deliveries', () => {
  it.each(['PENDING', 'SENDING'] as const)(
    're-enqueues a stuck %s row with a new generation',
    async (state) => {
      const id = await stuck(state);
      await app.get(ReconcileDeliveriesHandler).handle(cronCtx());
      expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
    },
  );
  it('two reconcilers in parallel on the same stuck rows: one new job each, generation +1 only', async () => {
    const a = await stuck('PENDING');
    const b = await stuck('SENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await Promise.all([h.handle(cronCtx()), h.handle(cronCtx())]);
    for (const id of [a, b]) {
      expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
      expect(
        (
          await owner.query(
            'SELECT enqueue_generation FROM email_deliveries WHERE public_id = $1',
            [id],
          )
        ).rows[0].enqueue_generation,
      ).toBe(1);
    }
  });
  it('running again inside the cooldown enqueues nothing new', async () => {
    const id = await stuck('PENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await h.handle(cronCtx());
    await h.handle(cronCtx());
    expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
  });
  it('a -g<n> job that failed before claiming does not block -g<n+1> later', async () => {
    const id = await stuck('PENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await h.handle(cronCtx());
    await owner.query(
      `UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 * 2) WHERE public_id = $1`,
      [id, COOLDOWN_SEC],
    );
    await h.handle(cronCtx());
    expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`, `${id}-g2`]);
  });
  it('gives up after NOTIFICATIONS_MAX_TOTAL_ATTEMPTS: FAILED + event in the same transaction, exactly once even run twice', async () => {
    const id = await stuck('SENDING', MAX_TOTAL);
    const h = app.get(ReconcileDeliveriesHandler);
    await h.handle(cronCtx());
    const { rows } = await owner.query(
      'SELECT state, lease_owner, lease_until, completed_at IS NOT NULL AS done, params_enc FROM email_deliveries WHERE public_id = $1',
      [id],
    );
    expect(rows[0]).toEqual({
      state: 'FAILED',
      lease_owner: null,
      lease_until: null,
      done: true,
      params_enc: null,
    });
    // FB4: fencing của failExhausted (WHERE ... AND STUCK) loại một dòng đã FAILED — đối soát lần hai
    // không được ghi lại event.
    await h.handle(cronCtx());
    const ev = await owner.query(
      `SELECT payload FROM outbox_events WHERE type = 'notifications.delivery.failed' AND payload->>'deliveryId' = $1`,
      [id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload.errorCode).toBe('ATTEMPTS_EXHAUSTED');
  });
  it('a SENDING row with an active lease is left untouched (no job, no state change, no event)', async () => {
    const key = `verify-email:${v7()}`;
    await app.get(EmailNotifications).request({
      template: 'verify-email',
      to: 's@example.test',
      idempotencyKey: key,
      params: { name: 'S', url: 'https://a.test/v' },
    });
    const { rows } = await owner.query(
      `UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 * 2), attempts = 1,
         state = 'SENDING', lease_owner = gen_random_uuid(), lease_until = now() + interval '5 minutes'
       WHERE idempotency_key = $1 RETURNING public_id`,
      [key, COOLDOWN_SEC],
    );
    const id = rows[0].public_id as string;
    await app.get(ReconcileDeliveriesHandler).handle(cronCtx());
    // Không job mới (chỉ còn job g0 lúc tạo), state và generation không đổi.
    expect(await jobIds(id)).toEqual([`${id}-g0`]);
    expect(
      (
        await owner.query(
          'SELECT state, enqueue_generation FROM email_deliveries WHERE public_id = $1',
          [id],
        )
      ).rows[0],
    ).toEqual({ state: 'SENDING', enqueue_generation: 0 });
    expect(
      (
        await owner.query(
          `SELECT 1 FROM outbox_events WHERE type = 'notifications.delivery.failed' AND payload->>'deliveryId' = $1`,
          [id],
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe('notifications.purge-deliveries', () => {
  it('deletes only SENT/FAILED rows older than the retention; never PENDING or SENDING, even when old', async () => {
    // oldSent/oldFailed/young đi tới trạng thái cuối nên cần attempts >= 1 (CHECK attempts_state_ck);
    // oldPending/oldSending giữ nguyên trạng thái không cuối (FB4/FB5: purge không bao giờ được xoá chúng,
    // kể cả khi created_at cũ hơn retention — DELETE có `state IN ('SENT','FAILED')` phòng hờ, FB5).
    const oldSent = await stuck('PENDING', 1);
    const oldFailed = await stuck('PENDING', 1);
    const young = await stuck('PENDING', 1);
    const oldPending = await stuck('PENDING');
    const oldSending = await stuck('SENDING');
    await owner.query(
      `UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, created_at = now() - interval '400 days' WHERE public_id = $1`,
      [oldSent],
    );
    await owner.query(
      `UPDATE email_deliveries SET state = 'FAILED', completed_at = now(), params_enc = NULL, created_at = now() - interval '400 days' WHERE public_id = $1`,
      [oldFailed],
    );
    await owner.query(
      `UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL WHERE public_id = $1`,
      [young],
    );
    await owner.query(
      `UPDATE email_deliveries SET created_at = now() - interval '400 days' WHERE public_id = $1`,
      [oldPending],
    );
    await owner.query(
      `UPDATE email_deliveries SET created_at = now() - interval '400 days' WHERE public_id = $1`,
      [oldSending],
    );
    await app.get(PurgeDeliveriesHandler).handle(cronCtx());
    const { rows } = await owner.query(
      'SELECT public_id FROM email_deliveries WHERE public_id = ANY($1)',
      [[oldSent, oldFailed, young, oldPending, oldSending]],
    );
    expect(
      rows.map((r) => r.public_id).sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [young, oldPending, oldSending].sort((a, b) => a.localeCompare(b)),
    );
  });
});
