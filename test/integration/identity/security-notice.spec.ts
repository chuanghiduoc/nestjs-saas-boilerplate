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
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import {
  EmailNotifications,
  NotificationsModule,
  type EmailRequest,
  type TemplateKey,
} from '../../../src/modules/notifications/index.js';
import { AuthEmails } from '../../../src/modules/identity/application/auth-emails.js';
import {
  ReconcileSecurityNoticesHandler,
  SecurityNoticeReconcileError,
} from '../../../src/modules/identity/application/reconcile-security-notices.handler.js';
import { SecurityNoticeService } from '../../../src/modules/identity/application/security-notice.service.js';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { PgSecurityNoticeLedger } from '../../../src/modules/identity/infra/better-auth/pg-security-notice-ledger.js';
import { IdentityDirectory } from '../../../src/modules/identity/ports/identity-directory.js';
import { SecurityNoticeLedger } from '../../../src/modules/identity/ports/security-notice-ledger.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

/** Cả hai bên phải tới barrier trong khoảng này, không thì fail rõ ràng thay vì treo tới testTimeout. */
const BARRIER_TIMEOUT_MS = 10_000;
/** Lớn hơn mặc định `AUTH_SECURITY_NOTICE_RECONCILE_GRACE_SEC`: marker "cũ" để cron nhặt ngay. */
const AGE = `interval '1 hour'`;

@Module({
  providers: [
    ...authPoolProviders,
    PgIdentityDirectory,
    { provide: IdentityDirectory, useExisting: PgIdentityDirectory },
    PgSecurityNoticeLedger,
    { provide: SecurityNoticeLedger, useExisting: PgSecurityNoticeLedger },
    AuthEmails,
    SecurityNoticeService,
    ReconcileSecurityNoticesHandler,
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
/** Lỗi hạ tầng của pool app giống thật (PgBouncer restart): chỉ có `code`. */
const infraError = () =>
  Object.assign(new Error('connection terminated'), { code: '08006' });

type NoticeRow = { kind: string; notified: boolean; deliveries: number };

describe('S2-R75 durable security notices (marker in the same statement + reconcile cron)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  let authPool: pg.Pool;
  const newUser = async () =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified) VALUES ('Sec', $1, true) RETURNING id`,
        [`sec-${v7()}@example.test`],
      )
    ).rows[0]!.id;
  /** Đổi cờ như Better Auth: một câu UPDATE autocommit qua pool `auth_user` (`internalAdapter.updateUser`). */
  const setTwoFactor = (userId: string, enabled: boolean) =>
    authPool.query(
      `UPDATE auth."user" SET two_factor_enabled = $2, updated_at = now() WHERE id = $1`,
      [userId, enabled],
    );
  /** Marker của user + số dòng `email_deliveries` mang đúng key của từng marker. */
  const noticesOf = async (userId: string): Promise<NoticeRow[]> =>
    (
      await owner.query<NoticeRow>(
        `SELECT n.kind, n.notified_at IS NOT NULL AS notified,
                (SELECT count(*)::int FROM public.email_deliveries d
                  WHERE d.idempotency_key = 'two-factor-changed:' || n.user_id || ':' || n.id) AS deliveries
           FROM auth.security_notice n WHERE n.user_id = $1 ORDER BY n.created_at, n.id`,
        [userId],
      )
    ).rows;
  /** Mọi thư 2FA của user, kể cả thư mang key không theo marker (bắt thư thứ hai sinh ra bởi key sai). */
  const allNoticeEmails = async (userId: string) =>
    (
      await owner.query(
        `SELECT 1 FROM public.email_deliveries WHERE idempotency_key LIKE $1`,
        [`two-factor-changed:${userId}:%`],
      )
    ).rows.length;
  const age = (userId: string) =>
    owner.query(
      `UPDATE auth.security_notice SET created_at = created_at - ${AGE} WHERE user_id = $1 AND notified_at IS NULL`,
      [userId],
    );
  const muteErrors = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      NotificationsModule.forApi(),
      M,
    ]);
    authPool = app.get<pg.Pool>(AUTH_POOL);
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
  });

  it('the database writes one marker in the same statement as a real 2FA flip (as auth_user); none for a no-op or unrelated update; none when the flip rolls back', async () => {
    const id = await newUser();
    await setTwoFactor(id, false);
    await authPool.query(
      `UPDATE auth."user" SET name = 'Renamed', updated_at = now() WHERE id = $1`,
      [id],
    );
    expect(await noticesOf(id)).toEqual([]);
    const c = await authPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`,
        [id],
      );
      // Cùng transaction: marker đã có trước khi commit.
      expect(
        (
          await c.query(
            `SELECT kind FROM auth.security_notice WHERE user_id = $1`,
            [id],
          )
        ).rows,
      ).toEqual([{ kind: 'two_factor_enabled' }]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await noticesOf(id)).toEqual([]);
    await setTwoFactor(id, true);
    await setTwoFactor(id, true);
    await setTwoFactor(id, false);
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: false, deliveries: 0 },
      { kind: 'two_factor_disabled', notified: false, deliveries: 0 },
    ]);
  });

  it('fast path: one email per marker with the marker time and direction, marker marked; running it again sends nothing', async () => {
    const id = await newUser();
    await setTwoFactor(id, true);
    const occurredAt = (
      await owner.query<{ t: Date }>(
        `SELECT created_at AS t FROM auth.security_notice WHERE user_id = $1`,
        [id],
      )
    ).rows[0]!.t;
    const request = vi.spyOn(app.get(EmailNotifications), 'request');
    const service = app.get(SecurityNoticeService);
    await service.afterChange(id);
    await service.afterChange(id);
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
    expect(await allNoticeEmails(id)).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      template: 'two-factor-changed',
      params: { enabled: true, occurredAt: occurredAt.toISOString() },
    });
    // Cron bỏ qua marker đã gửi, kể cả khi nó đã quá GRACE: không yêu cầu lại thư nào của user này.
    await owner.query(
      `UPDATE auth.security_notice SET created_at = created_at - ${AGE} WHERE user_id = $1`,
      [id],
    );
    await app.get(ReconcileSecurityNoticesHandler).handle(ctx());
    expect(
      request.mock.calls.filter(([r]) =>
        r.idempotencyKey.startsWith(`two-factor-changed:${id}:`),
      ),
    ).toHaveLength(1);
  });

  it('kill window: the 2FA change committed but the after-commit request fails; the reconcile cron later sends exactly one notice', async () => {
    const log = muteErrors();
    const id = await newUser();
    await setTwoFactor(id, true);
    vi.spyOn(app.get(EmailNotifications), 'request').mockRejectedValueOnce(
      infraError(),
    );
    await app.get(SecurityNoticeService).afterChange(id);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_notice_deferred',
        userId: id,
        code: '08006',
      }),
      expect.any(String),
    );
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: false, deliveries: 0 },
    ]);
    const h = app.get(ReconcileSecurityNoticesHandler);
    // Chưa quá GRACE: để cho đường gửi nhanh.
    await h.handle(ctx());
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: false, deliveries: 0 },
    ]);
    await age(id);
    await h.handle(ctx());
    await h.handle(ctx());
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
    expect(await allNoticeEmails(id)).toBe(1);
  });

  it('kill window at the marker step: the email request committed but marking failed; the cron re-requests the same key (no second email) and marks', async () => {
    muteErrors();
    const id = await newUser();
    await setTwoFactor(id, true);
    vi.spyOn(
      app.get(PgSecurityNoticeLedger),
      'markNotified',
    ).mockRejectedValueOnce(infraError());
    await app.get(SecurityNoticeService).afterChange(id);
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: false, deliveries: 1 },
    ]);
    await age(id);
    await app.get(ReconcileSecurityNoticesHandler).handle(ctx());
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
    expect(await allNoticeEmails(id)).toBe(1);
  });

  it('concurrency: the fast path and the cron request the same marker at the same time and produce one email', async () => {
    const id = await newUser();
    await setTwoFactor(id, false);
    await setTwoFactor(id, true);
    await age(id);
    const emails = app.get(EmailNotifications);
    const real = emails.request.bind(emails);
    let arrivals = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    const timedBarrier = Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `barrier timed out after ${BARRIER_TIMEOUT_MS}ms with ${arrivals} arrival(s); the cron never reached this user's marker`,
              ),
            ),
          BARRIER_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    vi.spyOn(emails, 'request').mockImplementation(
      async <K extends TemplateKey>(req: EmailRequest<K>) => {
        if (req.idempotencyKey.startsWith(`two-factor-changed:${id}:`)) {
          arrivals++;
          if (arrivals === 2) release();
          await timedBarrier;
        }
        return real(req);
      },
    );
    await Promise.all([
      app.get(SecurityNoticeService).afterChange(id),
      app.get(ReconcileSecurityNoticesHandler).handle(ctx()),
    ]);
    expect(arrivals).toBe(2);
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
    expect(await allNoticeEmails(id)).toBe(1);
  });

  it('two crons in parallel send one email per marker', async () => {
    const id = await newUser();
    await setTwoFactor(id, true);
    await setTwoFactor(id, false);
    await age(id);
    const h = app.get(ReconcileSecurityNoticesHandler);
    await Promise.all([h.handle(ctx()), h.handle(ctx())]);
    expect(await noticesOf(id)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
      { kind: 'two_factor_disabled', notified: true, deliveries: 1 },
    ]);
    expect(await allNoticeEmails(id)).toBe(2);
  });

  it('a notice that cannot be requested does not block the others; the run fails loudly and the next run sends it', async () => {
    const log = muteErrors();
    const bad = await newUser();
    const good = await newUser();
    await setTwoFactor(bad, true);
    await setTwoFactor(good, true);
    await age(bad);
    await age(good);
    const emails = app.get(EmailNotifications);
    const real = emails.request.bind(emails);
    const failing = vi
      .spyOn(emails, 'request')
      .mockImplementation(
        async <K extends TemplateKey>(req: EmailRequest<K>) => {
          if (req.idempotencyKey.startsWith(`two-factor-changed:${bad}:`))
            throw infraError();
          return real(req);
        },
      );
    const h = app.get(ReconcileSecurityNoticesHandler);
    await expect(h.handle(ctx())).rejects.toBeInstanceOf(
      SecurityNoticeReconcileError,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_notice_reconcile_failed',
        userId: bad,
      }),
      expect.any(String),
    );
    expect(await noticesOf(good)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
    expect(await noticesOf(bad)).toEqual([
      { kind: 'two_factor_enabled', notified: false, deliveries: 0 },
    ]);
    failing.mockRestore();
    await h.handle(ctx());
    expect(await noticesOf(bad)).toEqual([
      { kind: 'two_factor_enabled', notified: true, deliveries: 1 },
    ]);
  });
});
