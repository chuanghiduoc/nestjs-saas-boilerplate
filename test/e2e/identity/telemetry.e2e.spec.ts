import {
  Controller,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { IdentityModule } from '../../../src/modules/identity/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { AuthClient } from '../../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const mail = mailpitFromInfra();
const PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'wrong-password-123';
const LOCKOUT_MAX = 2;
/** `MAIL_FROM` của `baseTestEnv`: địa chỉ của chính hệ thống, không phải của user. */
const SYSTEM_SENDER = 'noreply@example.test';
/**
 * Địa chỉ email thật: TLD chữ cái. Không khớp `node_modules/@scope/...` hay thư mục pnpm (`bullmq@6.3.8_ioredis@...`)
 * trong stack trace của span/log.
 */
const EMAIL_ADDRESS =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
@Controller('probe')
class ProbeController {
  @Post('write') write() {
    return { ok: true };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * Carry-forward 6: bắt MỌI dòng log của cả file (Nest `ConsoleLogger` ghi thẳng `process.stdout/stderr`, gồm cả dòng
 * ERROR mà Better Auth in cho API key sai/đã xoá hay redirect không tin cậy, chuyển qua `logger.log` của
 * `auth-instance.ts`) và gom mọi secret đã dùng. Describe cuối kiểm không dòng nào chứa secret nào. Log vẫn được ghi
 * tiếp ra stream gốc (thấy được khi debug).
 */
const captured: string[] = [];
const secrets = new Set<string>();
const secret = <T extends string | undefined>(value: T): T => {
  if (value) secrets.add(value);
  return value;
};
/** Cookie session là `token.signature` (URL-encoded): cả cookie, dạng đã giải mã, token trần và chữ ký đều là secret. */
const sessionSecrets = (c: AuthClient) => {
  for (const [, v] of c.cookies) {
    secret(v);
    secret(decodeURIComponent(v));
    for (const part of decodeURIComponent(v).split('.'))
      if (part.length >= 16) secret(part);
  }
  secret(c.bearer);
};
const newEmail = (tag: string) => secret(`${tag}-${v7()}@example.test`);

beforeAll(() => {
  secret(PASSWORD);
  secret(WRONG_PASSWORD);
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(
      (
        chunk: string | Uint8Array,
        ...rest: [BufferEncoding?, ((err?: Error | null) => void)?]
      ) => {
        captured.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        const [encoding, cb] = rest;
        return encoding === undefined
          ? original(chunk, cb)
          : original(chunk, encoding, cb);
      },
    );
  }
});
afterAll(() => vi.restoreAllMocks());

/**
 * Review I8: mọi metric/span của spec §5.14 được đọc lại, không chỉ khai báo. Không assert giá trị tuyệt đối của
 * counter: global meter dùng chung cho cả file (kể cả app thứ hai ở describe dưới).
 */
describe('identity metrics and spans with a running app (spec §5.14)', () => {
  let app: INestApplication;
  let c: AuthClient;
  let email = '';
  beforeAll(async () => {
    app = await startIdentityApp({
      extraImports: [ProbeModule],
      env: { AUTH_LOCKOUT_MAX_FAILURES: String(LOCKOUT_MAX) },
    });
    c = new AuthClient(app.getHttpServer());
    email = newEmail('m');
    await c.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
  });
  afterAll(async () => app?.close());

  it('identity_sign_in_total{result} counts success, invalid and limited', async () => {
    await c.signIn(email, PASSWORD);
    sessionSecrets(c);
    const other = new AuthClient(app.getHttpServer());
    const victim = newEmail('v');
    for (let i = 0; i < LOCKOUT_MAX + 1; i++)
      await other.signIn(victim, WRONG_PASSWORD);
    expect(
      await otel.metric('identity_sign_in_total', { result: 'success' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('identity_sign_in_total', { result: 'invalid' }),
    ).toBeGreaterThanOrEqual(LOCKOUT_MAX);
    expect(
      await otel.metric('identity_sign_in_total', { result: 'limited' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('identity_lockout_blocked_total', { scope: 'signin' }),
    ).toBeGreaterThanOrEqual(1);
    expect(otel.spanNames()).toContain('identity.lockout.consume');
  });
  it('identity.authenticate span carries only the credential kind and result', async () => {
    otel.reset();
    expect(
      (await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer }))
        .status,
    ).toBe(200);
    const [span] = otel.spans('identity.authenticate');
    expect(span?.attributes).toEqual({
      'identity.credential.kind': 'BEARER_SESSION',
      'identity.auth.result': 'AUTHENTICATED',
    });
  });
  it('identity.lockout.consume span carries only the scope', async () => {
    otel.reset();
    await new AuthClient(app.getHttpServer()).signIn(
      newEmail('s'),
      WRONG_PASSWORD,
    );
    const [span] = otel.spans('identity.lockout.consume');
    expect(span?.attributes).toEqual({ 'identity.lockout.scope': 'signin' });
  });
  it('ambiguous credentials and CSRF rejections are counted', async () => {
    await request(app.getHttpServer())
      .get('/v1/me')
      .set('authorization', `Bearer ${c.bearer}`)
      .set('cookie', c.cookieHeader());
    await c.request('post', '/probe/write', {
      origin: 'https://evil.test',
      body: {},
    });
    expect(
      await otel.metric('identity_ambiguous_credentials_total'),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('identity_csrf_rejected_total'),
    ).toBeGreaterThanOrEqual(1);
  });
  it('auth pool gauge is exported', async () => {
    expect(
      await otel.metric('identity_auth_pool_connections', { state: 'total' }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('identity_client_ip_unresolved_total increases when the client address is not an IP', async () => {
    const before =
      (await otel.metric('identity_client_ip_unresolved_total')) ?? 0;
    const r = await new AuthClient(app.getHttpServer()).request(
      'post',
      '/api/auth/sign-in/email',
      {
        body: { email: newEmail('ip'), password: WRONG_PASSWORD },
        cookie: false,
        headers: { 'x-forwarded-for': 'not-an-ip' },
      },
    );
    expect(r.status).toBe(500);
    expect(await otel.metric('identity_client_ip_unresolved_total')).toBe(
      before + 1,
    );
  });
  it('identity_lockout_refund_failed_total{scope} increases when a refund cannot be written; the verified sign-in still succeeds (S2-R35)', async () => {
    const u = newEmail('rf');
    await new AuthClient(app.getHttpServer()).signUp(u, PASSWORD);
    await verifyEmailDirect(u);
    await ownerQuery('REVOKE DELETE ON auth.login_attempts FROM auth_user');
    try {
      expect(
        (await new AuthClient(app.getHttpServer()).signIn(u, PASSWORD)).status,
      ).toBe(200);
    } finally {
      await ownerQuery('GRANT DELETE ON auth.login_attempts TO auth_user');
    }
    expect(
      await otel.metric('identity_lockout_refund_failed_total', {
        scope: 'signin',
      }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('identity_auth_email_request_failed_total{template} increases when an auth email cannot be requested; the public answer is unchanged', async () => {
    const u = newEmail('ef');
    await new AuthClient(app.getHttpServer()).signUp(u, PASSWORD);
    await verifyEmailDirect(u);
    await ownerQuery('REVOKE INSERT ON email_deliveries FROM app_user');
    try {
      const r = await new AuthClient(app.getHttpServer()).request(
        'post',
        '/api/auth/request-password-reset',
        { body: { email: u }, cookie: false },
      );
      expect(r.status).toBe(200);
    } finally {
      await ownerQuery('GRANT INSERT ON email_deliveries TO app_user');
    }
    expect(
      await otel.metric('identity_auth_email_request_failed_total', {
        template: 'reset-password',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  /** Luồng đầy đủ cho kiểm PII ở describe cuối: mọi đường log lỗi của Better Auth, API key, email thật qua worker. */
  it('full flows: sign-up, verification link, sign-in, API keys (junk and deleted), reset, change-email, sign-out', async () => {
    const started = Date.now();
    const u = newEmail('pii');
    const w = new AuthClient(app.getHttpServer());
    expect((await w.signUp(u, PASSWORD)).status).toBe(202);
    expect((await w.signUp(u, PASSWORD)).status).toBe(202);
    const verifyMail = await mail.waitFor(u, {
      subject: /Verify your email/,
      after: started,
    });
    secret(/[?&]token=([^&\s"<>]+)/.exec(verifyMail.Text)?.[1]);
    expect(
      (await w.verifyEmailFromMailpit(mail, u, started)).status,
    ).toBeLessThan(400);
    expect((await w.signIn(u, WRONG_PASSWORD)).status).toBe(401);
    expect((await w.signIn(newEmail('unknown'), WRONG_PASSWORD)).status).toBe(
      401,
    );
    expect((await w.signIn(u, PASSWORD)).status).toBe(200);
    sessionSecrets(w);
    expect((await w.request('get', '/v1/me')).status).toBe(200);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, bearer: w.bearer }))
        .status,
    ).toBe(200);
    // Cookie + bearer: ambiguous (giá trị của cả hai là secret).
    expect(
      (await w.request('get', '/v1/me', { bearer: w.bearer })).status,
    ).toBe(400);

    // API key: tạo, dùng, key rác, xoá, dùng key đã xoá (Better Auth in dòng ERROR cho các đường này).
    const created = await w.request('post', '/api/auth/api-key/create', {
      body: { name: 'pii' },
    });
    expect(created.status).toBe(200);
    const key = secret(String(created.body.key));
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(200);
    const junk = secret(`${key.slice(0, 8)}${v7().replaceAll('-', '')}`);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: junk }))
        .status,
    ).toBe(401);
    expect(
      (
        await w.request('post', '/api/auth/api-key/delete', {
          body: { keyId: created.body.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (await w.request('get', '/v1/me', { cookie: false, apiKey: key })).status,
    ).toBe(401);

    // Quên mật khẩu: email có và không có (Better Auth log "User not found"); link đặt lại tới Mailpit.
    expect(
      (
        await w.request('post', '/api/auth/request-password-reset', {
          body: { email: u },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request('post', '/api/auth/request-password-reset', {
          body: { email: newEmail('nobody') },
          cookie: false,
        })
      ).status,
    ).toBe(200);
    const reset = await mail.waitFor(u, {
      subject: /Reset your password/,
      after: started,
    });
    const resetToken = /\/reset-password\/([^?\s"<>]+)/.exec(reset.Text)?.[1];
    expect(resetToken).toBeDefined();
    secret(resetToken);

    // Đổi email sang địa chỉ đã có và địa chỉ mới; redirect không tin cậy chứa email (message của Better Auth bị mask).
    expect(
      (
        await w.request('post', '/api/auth/change-email', {
          body: { newEmail: email },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await w.request('post', '/api/auth/change-email', {
          body: { newEmail: newEmail('new') },
        })
      ).status,
    ).toBe(202);
    const evilRedirect = await w.request('post', '/api/auth/sign-in/email', {
      body: {
        email: u,
        password: PASSWORD,
        callbackURL: `https://evil.test/?u=${u}`,
      },
      cookie: false,
    });
    expect(evilRedirect.status).toBe(422);
    await mail.waitFor(email, {
      subject: /You already have an account/,
      after: started,
    });

    expect((await w.request('post', '/api/auth/sign-out')).status).toBe(200);
  });
});

describe('identity_auth_unavailable_total with the auth DB unreachable', () => {
  it('increases on the mount and in the principal middleware', async () => {
    const before = (await otel.metric('identity_auth_unavailable_total')) ?? 0;
    const down = await startIdentityApp({
      env: { DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' },
    });
    try {
      const d = new AuthClient(down.getHttpServer());
      expect((await d.signIn(newEmail('d'), PASSWORD)).status).toBe(503);
      expect(
        (
          await request(down.getHttpServer())
            .get('/v1/me')
            .set('authorization', 'Bearer x')
        ).status,
      ).toBe(503);
    } finally {
      await down.close();
    }
    expect(
      await otel.metric('identity_auth_unavailable_total'),
    ).toBeGreaterThanOrEqual(before + 2);
  });
});

/** Task 45 (8caf10f): mọi từ chối của Bull Board được đếm theo `reason` (mã lỗi), không PII. */
describe('identity_dashboard_denied_total on the worker dashboard', () => {
  let worker: INestApplication;
  let url = '';
  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      APP_ROLE: 'worker',
      WORKER_QUEUES: 'events,notifications',
      QUEUE_DASHBOARD_ENABLED: 'true',
      QUEUE_DASHBOARD_PORT: '0',
      QUEUE_DASHBOARD_IP_ALLOWLIST: '127.0.0.1/32',
    }))
      vi.stubEnv(k, v);
    worker = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      NotificationsModule.forWorker(),
      IdentityModule.forWorker(),
    ]);
    url = `http://127.0.0.1:${worker.get(QueueDashboardServer).address().port}/queues/api/queues`;
  });
  afterAll(async () => {
    await worker?.close();
    vi.unstubAllEnvs();
  });

  it('counts a missing credential and an API key by reason', async () => {
    const before = {
      unauthenticated:
        (await otel.metric('identity_dashboard_denied_total', {
          reason: 'unauthenticated',
        })) ?? 0,
      forbidden:
        (await otel.metric('identity_dashboard_denied_total', {
          reason: 'forbidden',
        })) ?? 0,
    };
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { 'x-api-key': secret(`junk-${v7()}`) } }))
        .status,
    ).toBe(403);
    expect(
      await otel.metric('identity_dashboard_denied_total', {
        reason: 'unauthenticated',
      }),
    ).toBe(before.unauthenticated + 1);
    expect(
      await otel.metric('identity_dashboard_denied_total', {
        reason: 'forbidden',
      }),
    ).toBe(before.forbidden + 1);
  });
});

describe('no PII or secret in logs, metric labels or span attributes (carry-forwards 6 and 7, criterion 16)', () => {
  it('no log line of the whole file carries an e-mail, password, token, cookie value or API key', () => {
    const lines = captured.join('').split('\n');
    // Bộ bắt log thật sự thấy log của app: có dòng ERROR của Better Auth (redirect không tin cậy, đã mask).
    expect(lines.some((l) => l.includes('Invalid callbackURL: [email]'))).toBe(
      true,
    );
    expect(secrets.size).toBeGreaterThan(10);
    const leaks = [...secrets].flatMap((s) =>
      lines
        .filter((l) => l.toLowerCase().includes(s.toLowerCase()))
        .map((l) => `${s} in: ${l}`),
    );
    expect(leaks).toEqual([]);
    const addresses = lines
      .flatMap((l) => l.match(EMAIL_ADDRESS) ?? [])
      .filter((a) => a !== SYSTEM_SENDER);
    expect(addresses).toEqual([]);
  });

  it('metric labels of identity_* and notifications_* never carry an address, a UUID or a secret', async () => {
    const points = [
      ...(await otel.dataPoints('identity_')),
      ...(await otel.dataPoints('notifications_')),
    ];
    expect(points.length).toBeGreaterThan(0);
    for (const p of points)
      for (const [k, v] of Object.entries(p.attributes)) {
        const value = String(v);
        expect(value, `${p.name}{${k}}`).not.toMatch(
          /@|[0-9a-f]{8}-[0-9a-f]{4}-/i,
        );
        expect(
          [...secrets].filter((s) => value.includes(s)),
          `${p.name}{${k}}`,
        ).toEqual([]);
      }
  });

  it('span attributes and exception events never carry an e-mail address or a secret', () => {
    const names = new Set(otel.spanNames());
    expect([...names]).toEqual(
      expect.arrayContaining([
        'identity.authenticate',
        'identity.lockout.consume',
      ]),
    );
    for (const name of names)
      for (const s of otel.spans(name)) {
        const values = [
          ...Object.values(s.attributes),
          ...s.events.flatMap((e) => Object.values(e.attributes ?? {})),
        ].map(String);
        for (const value of values) {
          // Span của queue (vd. `job notifications.send-email`) ghi exception kèm stack: đường dẫn pnpm có `@`.
          expect(value.match(EMAIL_ADDRESS) ?? [], name).toEqual([]);
          expect(
            [...secrets].filter((x) => value.includes(x)),
            name,
          ).toEqual([]);
        }
      }
  });
});
