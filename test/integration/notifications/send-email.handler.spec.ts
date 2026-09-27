import { Logger, type INestApplication } from '@nestjs/common';
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
import { errSerializer } from '../../../src/core/logging/index.js';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { JobPayloadError, QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import {
  EmailNotifications,
  NotificationsModule,
} from '../../../src/modules/notifications/index.js';
import { SendEmailHandler } from '../../../src/modules/notifications/application/send-email.handler.js';
import { DeliveryLeaseBusyError } from '../../../src/modules/notifications/errors.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeSmtp, type FakeSmtp } from '../../support/fake-smtp.js';
import { getInfra } from '../../support/infra.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const LEASE_MS = 1500;
const DEADLINE_MS = 1000;
const MAX_ATTEMPTS = 3;
let owner: pg.Client;
const row = async (key: string) =>
  (
    await owner.query(
      'SELECT public_id, state, lease_owner, lease_until, attempts, last_error_code, completed_at, params_enc FROM email_deliveries WHERE idempotency_key = $1',
      [key],
    )
  ).rows[0];
const failedEvents = async (id: string) =>
  (
    await owner.query(
      `SELECT payload FROM outbox_events WHERE type = 'notifications.delivery.failed' AND payload->>'deliveryId' = $1`,
      [id],
    )
  ).rows;
const ctx = (
  deliveryId: string,
  attempt = 1,
  signal = new AbortController().signal,
) => ({
  payload: { deliveryId },
  meta: {},
  jobId: `${deliveryId}-g0`,
  attempt,
  maxAttempts: MAX_ATTEMPTS,
  signal,
  log: new Logger('test'),
});

async function makeApp(smtpPort?: number): Promise<INestApplication> {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('NOTIFICATIONS_CLAIM_LEASE_MS', String(LEASE_MS));
  vi.stubEnv('SMTP_SEND_DEADLINE_MS', String(DEADLINE_MS));
  vi.stubEnv('QUEUE_DEFAULT_ATTEMPTS', String(MAX_ATTEMPTS));
  if (smtpPort !== undefined) {
    vi.stubEnv('SMTP_HOST', '127.0.0.1');
    vi.stubEnv('SMTP_PORT', String(smtpPort));
  }
  return createTestApp([
    DatabaseModule.forRoot({ relay: false }),
    RedisModule,
    QueueModule.forRoot({ runWorkers: false }),
    OutboxModule.forRoot({ relay: false }),
    EventsModule.forRoot({ worker: false }),
    ResilienceModule,
    NotificationsModule.forWorker(),
  ]);
}
async function requestOne(
  app: INestApplication,
  to = `u-${v7()}@example.test`,
) {
  const key = `verify-email:${v7()}`;
  await app.get(EmailNotifications).request({
    template: 'verify-email',
    to,
    idempotencyKey: key,
    params: { name: 'U', url: 'https://app.example.test/v?t=1' },
  });
  return { key, to, id: (await row(key)).public_id as string };
}

beforeAll(async () => {
  const { pg: p } = getInfra();
  owner = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await owner.connect();
});
afterAll(async () => owner?.end());

describe('SendEmailHandler', () => {
  let app: INestApplication | undefined;
  let fake: FakeSmtp | undefined;
  afterEach(async () => {
    await app?.close();
    await fake?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    app = undefined;
    fake = undefined;
  });

  it('claims, sends to Mailpit, and completes: SENT, params dropped, lease cleared', async () => {
    app = await makeApp();
    const { key, to, id } = await requestOne(app);
    await app.get(SendEmailHandler).handle(ctx(id));
    await mailpitFromInfra().waitFor(to, { subject: /Verify your email/ });
    expect(await row(key)).toMatchObject({
      state: 'SENT',
      lease_owner: null,
      lease_until: null,
      params_enc: null,
      attempts: 1,
    });
    await app.get(SendEmailHandler).handle(ctx(id));
  });
  it('two concurrent jobs on one delivery: exactly one sends, the other gets DeliveryLeaseBusyError', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const results = await Promise.allSettled([
      h.handle(ctx(id)),
      h.handle(ctx(id)),
    ]);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' && r.reason instanceof DeliveryLeaseBusyError,
      ),
    ).toHaveLength(1);
  });
  it('a retry before the lease expires never reports success', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const first = h.handle(ctx(id)).catch((e: unknown) => e);
    await vi.waitFor(async () =>
      expect(
        (
          await owner.query(
            'SELECT state FROM email_deliveries WHERE public_id = $1',
            [id],
          )
        ).rows[0].state,
      ).toBe('SENDING'),
    );
    await expect(h.handle(ctx(id, 2))).rejects.toBeInstanceOf(
      DeliveryLeaseBusyError,
    );
    await first;
  });
  it('lease lost while SMTP is slow: the old owner is fenced out and does not flip the row', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const slow = h.handle(ctx(id)).catch((e: unknown) => e);
    await vi.waitFor(async () =>
      expect((await row(key)).state).toBe('SENDING'),
    );
    await owner.query(
      `UPDATE email_deliveries SET lease_owner = $2, lease_until = now() + interval '1 hour' WHERE public_id = $1`,
      [id, v7()],
    );
    await slow;
    expect((await row(key)).state).toBe('SENDING');
  });
  it('transient failure: back to PENDING with both lease columns NULL and the error code', async () => {
    fake = await startFakeSmtp('reject451');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    await expect(
      app.get(SendEmailHandler).handle(ctx(id)),
    ).rejects.toMatchObject({ code: 'SMTP_TRANSIENT' });
    expect(await row(key)).toMatchObject({
      state: 'PENDING',
      lease_owner: null,
      lease_until: null,
      last_error_code: 'SMTP_TRANSIENT',
    });
  });
  it('permanent failure: FAILED + event committed before the job fails (unrecoverable), no address anywhere', async () => {
    fake = await startFakeSmtp('reject550');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app, 'victim@example.com');
    const err = await app
      .get(SendEmailHandler)
      .handle(ctx(id))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobPayloadError);
    expect(String(err)).not.toContain('victim@example.com');
    expect(await row(key)).toMatchObject({
      state: 'FAILED',
      last_error_code: 'SMTP_PERMANENT',
      params_enc: null,
    });
    expect((await failedEvents(id)).map((r) => r.payload)).toEqual([
      { deliveryId: id, template: 'verify-email', errorCode: 'SMTP_PERMANENT' },
    ]);
    // FAILED là trạng thái cuối: job chạy lại (stalled/duplicate) thành công idempotent, không phát event lần hai.
    await app.get(SendEmailHandler).handle(ctx(id, 2));
    expect(await failedEvents(id)).toHaveLength(1);
  });
  it('transient failure on the last attempt: FAILED + event, and a normal error so BullMQ marks the job failed', async () => {
    fake = await startFakeSmtp('reject451');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    const err = await app
      .get(SendEmailHandler)
      .handle(ctx(id, MAX_ATTEMPTS))
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JobPayloadError);
    expect(await row(key)).toMatchObject({
      state: 'FAILED',
      last_error_code: 'SMTP_TRANSIENT',
    });
    expect(await failedEvents(id)).toHaveLength(1);
  });
  it('unknown locale or invalid params fails the delivery permanently', async () => {
    app = await makeApp();
    const { key, id } = await requestOne(app);
    await owner.query(
      `UPDATE email_deliveries SET locale = 'fr' WHERE public_id = $1`,
      [id],
    );
    await expect(
      app.get(SendEmailHandler).handle(ctx(id)),
    ).rejects.toBeInstanceOf(JobPayloadError);
    expect(await row(key)).toMatchObject({
      state: 'FAILED',
      last_error_code: null,
      params_enc: null,
    });
    expect((await failedEvents(id))[0].payload.errorCode).toBe('RENDER_FAILED');
  });
  it('a missing delivery is a permanent payload error', async () => {
    app = await makeApp();
    await expect(
      app.get(SendEmailHandler).handle(ctx(v7())),
    ).rejects.toBeInstanceOf(JobPayloadError);
  });

  // Ngoài brief (dispatch Task 23): hợp đồng abort của SP1 và không PII trên đường lỗi.
  it('an already-aborted signal throws before claiming: the row stays PENDING and unclaimed', async () => {
    app = await makeApp();
    const { key, id } = await requestOne(app);
    const ac = new AbortController();
    ac.abort(new Error('worker shutting down'));
    await expect(
      app.get(SendEmailHandler).handle(ctx(id, 1, ac.signal)),
    ).rejects.toThrow();
    expect(await row(key)).toMatchObject({
      state: 'PENDING',
      attempts: 0,
      lease_owner: null,
    });
  });
  it('abort during a slow send on the last attempt releases the lease (PENDING) instead of failing the delivery', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    const ac = new AbortController();
    const pending = app
      .get(SendEmailHandler)
      .handle(ctx(id, MAX_ATTEMPTS, ac.signal))
      .catch((e: unknown) => e);
    await vi.waitFor(async () =>
      expect((await row(key)).state).toBe('SENDING'),
    );
    ac.abort(new Error('worker shutting down'));
    expect(await pending).toBeInstanceOf(Error);
    expect(await row(key)).toMatchObject({
      state: 'PENDING',
      lease_owner: null,
      lease_until: null,
    });
    expect(await failedEvents(id)).toHaveLength(0);
  });
  it('error paths never put the recipient address into logs or thrown errors', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        },
      );
    const address = `pii-${v7()}@example.com`;
    const errors: unknown[] = [];
    for (const mode of ['reject451', 'reject550'] as const) {
      fake = await startFakeSmtp(mode);
      app = await makeApp(fake.port);
      const { id } = await requestOne(app, address);
      errors.push(
        await app
          .get(SendEmailHandler)
          .handle(ctx(id))
          .catch((e: unknown) => e),
      );
      await app.close();
      await fake.close();
      app = undefined;
      fake = undefined;
    }
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    for (const e of errors)
      expect(JSON.stringify(errSerializer(e))).not.toContain(address);
    expect(lines.join('\n')).not.toContain(address);
  });
});
