import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import {
  EventPublisher,
  EventsModule,
} from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { RegisteredEventService } from '../../../src/modules/identity/application/registered-event.service.js';
import { ReconcileRegisteredHandler } from '../../../src/modules/identity/application/reconcile-registered.handler.js';
import { registeredEventId } from '../../../src/modules/identity/events.js';
import {
  authPoolProviders,
  AUTH_POOL,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgRegistrationLedger } from '../../../src/modules/identity/infra/better-auth/pg-registration-ledger.js';
import { RegistrationLedger } from '../../../src/modules/identity/ports/registration-ledger.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const GRACE_SEC = 1;
/** review M5: cả hai publish phải tới trong khoảng này, không thì fail rõ ràng thay vì treo tới testTimeout. */
const BARRIER_TIMEOUT_MS = 10_000;
@Module({
  providers: [
    ...authPoolProviders,
    PgRegistrationLedger,
    { provide: RegistrationLedger, useExisting: PgRegistrationLedger },
    RegisteredEventService,
    ReconcileRegisteredHandler,
  ],
})
class M {}
const ctx = () => ({
  payload: {},
  meta: {},
  jobId: v7(),
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('t'),
});

describe('identity.user.registered: after-hook + reconcile (spec §5.10)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  const newUser = async (agoSec = 0) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('N', $1, false, now() - make_interval(secs => $2), now()) RETURNING id`,
        [`r-${v7()}@example.test`, agoSec],
      )
    ).rows[0]!.id;
  const events = async (userId: string) =>
    (
      await owner.query(
        `SELECT event_id FROM public.outbox_events WHERE event_id = $1`,
        [registeredEventId(userId)],
      )
    ).rows.length;
  /** spec §5.10: "orgId: null, actor `user`" — user chưa vào org nào lúc đăng ký. */
  const eventOrgId = async (userId: string) =>
    (
      await owner.query<{ org_id: string | null }>(
        `SELECT org_id FROM public.outbox_events WHERE event_id = $1`,
        [registeredEventId(userId)],
      )
    ).rows[0]?.org_id;
  const marked = async (userId: string) =>
    (
      await owner.query<{ m: boolean }>(
        `SELECT registered_event_emitted_at IS NOT NULL AS m FROM auth."user" WHERE id = $1`,
        [userId],
      )
    ).rows[0]!.m;
  beforeAll(async () => {
    vi.stubEnv('AUTH_REGISTERED_RECONCILE_GRACE_SEC', String(GRACE_SEC));
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      M,
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
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await owner?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('happy path: one event with the v5 id, marker set', async () => {
    const id = await newUser();
    await app.get(RegisteredEventService).onUserCreated(id);
    expect([await events(id), await marked(id)]).toEqual([1, true]);
    expect(await eventOrgId(id)).toBeNull();
  });
  it('after-hook fails at the outbox step → the cron emits exactly one event', async () => {
    // review M6: onUserCreated's catch block logs at 'error' level by design (log không PII rồi để cron
    // bù); mute nó ở đây và assert nó thật sự được gọi, thay vì để nó in ra ERROR trên một lần chạy xanh.
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const id = await newUser(GRACE_SEC * 5);
    vi.spyOn(app.get(EventPublisher), 'publish').mockRejectedValueOnce(
      new Error('outbox down'),
    );
    await app.get(RegisteredEventService).onUserCreated(id);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'registered_event_deferred' }),
      expect.any(String),
    );
    expect([await events(id), await marked(id)]).toEqual([0, false]);
    await app.get(ReconcileRegisteredHandler).handle(ctx());
    expect([await events(id), await marked(id)]).toEqual([1, true]);
    expect(
      otel.spans('identity.registered.reconcile').at(-1)?.attributes[
        'identity.reconcile.processed'
      ],
    ).toBeGreaterThanOrEqual(1);
  });
  it('after-hook fails at the marker step → the cron re-appends the same id (no duplicate) and marks', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const id = await newUser(GRACE_SEC * 5);
    vi.spyOn(app.get(PgRegistrationLedger), 'mark').mockRejectedValueOnce(
      new Error('auth pool down'),
    );
    await app.get(RegisteredEventService).onUserCreated(id);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'registered_event_deferred' }),
      expect.any(String),
    );
    expect([await events(id), await marked(id)]).toEqual([1, false]);
    await app.get(ReconcileRegisteredHandler).handle(ctx());
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
  it('a user transaction committed later than GRACE is still found (no time window)', async () => {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const client = await pool.connect();
    const onError = (error: Error) => {
      clientError = error;
    };
    let clientError: Error | undefined;
    client.on('error', onError);
    // review M4: chỉ ROLLBACK khi COMMIT chưa chạy; ROLLBACK sau một COMMIT đã thành công không làm gì
    // ngoài việc Postgres báo NOTICE "no transaction in progress" trên mọi lần chạy xanh.
    let committed = false;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('L', $1, false, now(), now()) RETURNING id`,
        [`late-${v7()}@example.test`],
      );
      await new Promise((r) => setTimeout(r, (GRACE_SEC + 1) * 1000));
      await app.get(ReconcileRegisteredHandler).handle(ctx());
      await client.query('COMMIT');
      committed = true;
      await app.get(ReconcileRegisteredHandler).handle(ctx());
      expect(await events(rows[0]!.id)).toBe(1);
    } finally {
      try {
        if (!committed) await client.query('ROLLBACK');
      } finally {
        try {
          client.release(clientError);
        } finally {
          client.removeListener('error', onError);
        }
      }
    }
    if (clientError) throw clientError;
  });
  it('two reconcilers in parallel emit one event; a user unmarked for 30 days is still reconciled', async () => {
    const id = await newUser(30 * 86400);
    const h = app.get(ReconcileRegisteredHandler);
    await Promise.all([h.handle(ctx()), h.handle(ctx())]);
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
  it('concurrent after-hook and reconcile append exactly one outbox row', async () => {
    const id = await newUser(GRACE_SEC * 5);
    const service = app.get(RegisteredEventService);
    const publish = service.publish.bind(service);
    let arrivals = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let barrierTimer: NodeJS.Timeout;
    const timedBarrier = Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        barrierTimer = setTimeout(
          () =>
            reject(
              new Error(
                `barrier timed out after ${BARRIER_TIMEOUT_MS}ms with only ${arrivals} arrival(s); the reconciler likely never reached this test's user (batchSize × maxBatches too small, or a leftover backlog from another test)`,
              ),
            ),
          BARRIER_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(barrierTimer));
    vi.spyOn(service, 'publish').mockImplementation(async (userId) => {
      if (userId === id) {
        arrivals++;
        if (arrivals === 2) release();
        await timedBarrier;
      }
      await publish(userId);
    });
    await Promise.all([
      service.onUserCreated(id),
      app.get(ReconcileRegisteredHandler).handle(ctx()),
    ]);
    expect(arrivals).toBe(2);
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
  it('the backlog-age gauge keeps rising through a persistent ledger failure instead of freezing (review I1)', async () => {
    await newUser(GRACE_SEC * 5);
    // `mark` reject mãi (không chỉ once): batch nào cũng throw, đúng kiểu outage mà gauge phải báo được.
    vi.spyOn(app.get(PgRegistrationLedger), 'mark').mockRejectedValue(
      new Error('auth pool down'),
    );
    const h = app.get(ReconcileRegisteredHandler);
    await expect(h.handle(ctx())).rejects.toThrow('auth pool down');
    const first = await otel.metric(
      'identity_registered_unmarked_oldest_seconds',
    );
    expect(first).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1_200));
    // Batch vẫn throw như lần trước; nếu gauge chỉ được đo sau khi batch thành công (bug cũ), giá trị sẽ
    // đứng yên ở `first` mãi thay vì tăng theo tuổi thật của user chưa được mark.
    await expect(h.handle(ctx())).rejects.toThrow('auth pool down');
    const second = await otel.metric(
      'identity_registered_unmarked_oldest_seconds',
    );
    expect(second).toBeGreaterThan(first as number);
  });
});
