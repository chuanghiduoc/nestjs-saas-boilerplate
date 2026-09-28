import { inspect } from 'node:util';
import { Logger, type INestApplication } from '@nestjs/common';
import {
  ToxiProxyContainer,
  type CreatedProxy,
  type StartedToxiProxyContainer,
} from '@testcontainers/toxiproxy';
import { CircuitBreakerPolicy, CircuitState } from 'cockatiel';
import type pg from 'pg';
import request, { type Response } from 'supertest';
import {
  GenericContainer,
  Network,
  TestContainers,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { healthConfig } from '../../src/core/health/index.js';
import {
  REDIS,
  redisConfig,
  type RedisClient,
} from '../../src/core/redis/index.js';
import { ResiliencePolicies } from '../../src/core/resilience/index.js';
import { authDatabaseConfig } from '../../src/modules/identity/identity.config.js';
import { AUTH_POOL } from '../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { ReconcileDeliveriesHandler } from '../../src/modules/notifications/application/reconcile-deliveries.handler.js';
import { SMTP_RESILIENCE_PROVIDER } from '../../src/modules/notifications/notifications.config.js';
import { AuthClient } from '../support/auth-client.js';
import {
  ownerQuery,
  startIdentityApp,
  verifyEmailDirect,
} from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { Mailpit } from '../support/mailpit.js';
import { readImages } from '../support/images.js';

const REDIS_PORT = 6379;
const SMTP_PORT = 1025;
const MAILPIT_API = 8025;
const PASSWORD = 'correct horse battery';

/**
 * Tham số của bộ test (không phải config của app).
 * - `QUEUE_ATTEMPTS` là `QUEUE_DEFAULT_ATTEMPTS` của app test: số lần claim tối đa của một job gửi thư.
 * - Brief ghi `NOTIFICATIONS_CLAIM_LEASE_MS=1500`, nhưng luật `notifications-backoff-exceeds-lease` đòi tổng backoff
 *   500 × (2^(3−1) − 1) = 1500 ms phải LỚN HƠN lease (app không boot với 1500). 1200 giữ nguyên hai luật còn lại:
 *   `SMTP_SEND_DEADLINE_MS` 1000 < lease 1200 < tổng backoff 1500.
 * - `LATENCY_MARGIN_MS`: phần cộng thêm vào timeout đã cấu hình khi đo thời gian trả lời (supertest, event loop, và
 *   port-forward của Docker Desktop tới Toxiproxy). Mỗi bound = timeout của app + margin này.
 * - `THROTTLE_LIMIT`/`PRE_AUTH_LIMIT` nhỏ để chứng minh limiter vẫn chặn (insurance) khi Redis sập.
 * - `MAIL_SETTLE_MS` > tổng backoff của job: chờ mọi lần thử còn lại chạy xong trước khi đếm thư trong Mailpit.
 * - `SMTP_DOWN_CODES`: mã của một lần gửi khi Toxiproxy tắt proxy SMTP. Trên Linux cổng đóng → ECONNREFUSED →
 *   `SMTP_CONNECTION`. Port-forward của Docker Desktop nhận TCP rồi đóng ngay, pool của nodemailer (`maxRequeues: 0`)
 *   báo lỗi chung "Reached maximum number of retries after connection was closed" không có `code` → `SMTP_TRANSIENT`.
 *   Cả hai đều là lỗi tạm thời (nhả lease, retry), đúng spec §5.11 bước 5.
 */
const QUEUE_ATTEMPTS = 3;
const LATENCY_MARGIN_MS = 1500;
const THROTTLE_LIMIT = 6;
const PRE_AUTH_LIMIT = 4;
const MAIL_SETTLE_MS = 3000;
const DB_LATENCY_TOXIC_MS = 1500;
const WAIT = { timeout: 30_000, interval: 25 };
const MAIL_WAIT_MS = 60_000;
const SMTP_DOWN_CODES = ['SMTP_CONNECTION', 'SMTP_TRANSIENT'];

type DeliveryRow = {
  id: string;
  public_id: string;
  template: string;
  state: string;
  attempts: number;
  enqueue_generation: number;
  last_error_code: string | null;
};
type Timed = { res: Response; ms: number; doneAt: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn: () => Promise<Response>): Promise<Timed> => {
  const t = performance.now();
  const res = await fn();
  const doneAt = performance.now();
  return { res, ms: doneAt - t, doneAt };
};
const deliveriesAfter = (id: string) =>
  ownerQuery<DeliveryRow>(
    `SELECT id::text, public_id::text, template, state, attempts, enqueue_generation, last_error_code
       FROM email_deliveries WHERE id > $1::bigint ORDER BY id`,
    [id],
  );
const maxDeliveryId = async () =>
  (
    await ownerQuery<{ id: string }>(
      `SELECT coalesce(max(id), 0)::text AS id FROM email_deliveries`,
    )
  )[0]?.id ?? '0';
const maxOutboxId = async () =>
  (
    await ownerQuery<{ id: string }>(
      `SELECT coalesce(max(id), 0)::text AS id FROM outbox_events`,
    )
  )[0]?.id ?? '0';
const unpublishedAfter = async (id: string) =>
  Number(
    (
      await ownerQuery<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE id > $1::bigint AND published_at IS NULL`,
        [id],
      )
    )[0]?.n ?? 0,
  );
const failedEvents = async (publicId: string) =>
  Number(
    (
      await ownerQuery<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE type = 'notifications.delivery.failed' AND aggregate_id = $1`,
        [publicId],
      )
    )[0]?.n ?? 0,
  );
/** 503 problem+json có `Retry-After`: dạng trả lời duy nhất được phép khi storage auth không dùng được. */
const expectUnavailable = (label: string, t: Timed, boundMs: number) => {
  expect(
    [
      t.res.status,
      t.res.body?.code,
      t.res.headers['content-type']?.includes('application/problem+json'),
      Number(t.res.headers['retry-after']) > 0,
    ],
    label,
  ).toEqual([503, 'service_unavailable', true, true]);
  expect(t.ms, `${label} latency`).toBeLessThanOrEqual(boundMs);
};

describe('identity and email under dependency outages', () => {
  let net: StartedNetwork;
  let redis: StartedTestContainer;
  let mailpitC: StartedTestContainer;
  let toxi: StartedToxiProxyContainer;
  let redisProxy: CreatedProxy;
  let smtpProxy: CreatedProxy;
  let authDbProxy: CreatedProxy;
  let app: INestApplication;
  let mailpit: Mailpit;
  let redisBoundMs = 0;
  let dbBoundMs = 0;
  let authPoolMax = 0;
  /** Mọi email/credential bộ test dùng: không một giá trị nào được xuất hiện trong log (spec §1 tiêu chí 16). */
  const secrets = new Set<string>([PASSWORD]);
  const crashes: { kind: string; err: unknown }[] = [];
  const onUncaught = (err: unknown) =>
    crashes.push({ kind: 'uncaughtException', err });
  const onUnhandled = (err: unknown) =>
    crashes.push({ kind: 'unhandledRejection', err });
  const logSpies: MockInstance[] = [];
  /**
   * Mọi lời gọi Logger của cả file, gom sau mỗi test: Vitest 5 mặc định `clearMocks: true`, xoá `mock.calls` của spy
   * trước mỗi test, nên phải gom ở `afterEach` thì test cuối mới thấy log của mọi sự cố.
   */
  const logged: string[] = [];
  /** `warn` của instance Logger: readiness ghi kết quả terminus (gồm `auth_database`) ở đây. */
  let warnSpy: MockInstance | undefined;

  const server = () => app.getHttpServer();
  const pool = () => app.get<pg.Pool>(AUTH_POOL);
  const ready = () => request(server()).get('/health/ready');
  const redisAnswers = async (): Promise<boolean> => {
    try {
      return (await app.get<RedisClient>(REDIS).ping()) === 'PONG';
    } catch {
      return false;
    }
  };
  const reconcile = () =>
    app.get(ReconcileDeliveriesHandler).handle({
      payload: {},
      meta: {},
      jobId: v7(),
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
      log: new Logger('chaos'),
    });
  const newUser = async (prefix: string) => {
    const email = `${prefix}-${v7()}@example.test`;
    secrets.add(email);
    const c = new AuthClient(server());
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    await verifyEmailDirect(email);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    for (const v of c.cookies.values()) secrets.add(v);
    if (c.bearer) secrets.add(c.bearer);
    return { email, c };
  };
  /**
   * Lưới an toàn sau mỗi test (mỗi test đã tự khôi phục trong `finally`): `POST /reset` của Toxiproxy bật lại mọi
   * proxy và gỡ mọi toxic, nên sự cố của một test dừng giữa chừng không tràn sang test sau.
   */
  const restoreAll = async () => {
    await toxi?.client.reset();
  };
  /** Trạng thái breaker của provider `smtp` (policy `single` = wrap(bulkhead, breaker, timeout), spec §5.11 bước 3). */
  const smtpBreaker = (): CircuitState => {
    const single = app
      .get(ResiliencePolicies)
      .for(SMTP_RESILIENCE_PROVIDER).single;
    const wrapped: unknown = Reflect.get(single, 'wrapped');
    const breaker = Array.isArray(wrapped)
      ? wrapped.find(
          (p: unknown): p is CircuitBreakerPolicy =>
            p instanceof CircuitBreakerPolicy,
        )
      : undefined;
    if (!breaker) throw new Error('smtp policy has no circuit breaker');
    return breaker.state;
  };

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    warnSpy = vi.spyOn(Logger.prototype, 'warn');
    logSpies.push(warnSpy, vi.spyOn(Logger, 'warn'));
    for (const m of ['log', 'error', 'debug', 'verbose', 'fatal'] as const)
      logSpies.push(vi.spyOn(Logger.prototype, m), vi.spyOn(Logger, m));
    const images = readImages();
    const { pg: p } = getInfra();
    await TestContainers.exposeHostPorts(p.port);
    net = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS!)
      .withNetwork(net)
      .withNetworkAliases('redis')
      .withExposedPorts(REDIS_PORT)
      .start();
    mailpitC = await new GenericContainer(images.IMAGE_MAILPIT!)
      .withNetwork(net)
      .withNetworkAliases('mailpit')
      .withExposedPorts(MAILPIT_API)
      .start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY!)
      .withNetwork(net)
      .start();
    redisProxy = await toxi.createProxy({
      name: 'redis',
      upstream: `redis:${REDIS_PORT}`,
    });
    smtpProxy = await toxi.createProxy({
      name: 'smtp',
      upstream: `mailpit:${SMTP_PORT}`,
    });
    authDbProxy = await toxi.createProxy({
      name: 'authdb',
      upstream: `host.testcontainers.internal:${p.port}`,
    });
    mailpit = new Mailpit(
      `http://${mailpitC.getHost()}:${mailpitC.getMappedPort(MAILPIT_API)}`,
    );
    app = await startIdentityApp({
      env: {
        REDIS_URL: `redis://${redisProxy.host}:${redisProxy.port}`,
        SMTP_HOST: smtpProxy.host,
        SMTP_PORT: String(smtpProxy.port),
        DB_AUTH_HOST: authDbProxy.host,
        DB_AUTH_PORT: String(authDbProxy.port),
        DB_AUTH_CONNECTION_TIMEOUT_MS: '500',
        OUTBOX_POLL_INTERVAL_MS: '200',
        QUEUE_DEFAULT_BACKOFF_MS: '500',
        QUEUE_DEFAULT_ATTEMPTS: String(QUEUE_ATTEMPTS),
        NOTIFICATIONS_CLAIM_LEASE_MS: '1200',
        SMTP_SEND_DEADLINE_MS: '1000',
        NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC: '1',
        THROTTLE_DEFAULT_LIMIT: String(THROTTLE_LIMIT),
        THROTTLE_PRE_AUTH_LIMIT: String(PRE_AUTH_LIMIT),
      },
    });
    const authDb = app.get<{ connectionTimeoutMs: number; poolMax: number }>(
      authDatabaseConfig.KEY,
    );
    const health = app.get<{ checkTimeoutMs: number }>(healthConfig.KEY);
    const redisCfg = app.get<{ commandTimeoutMs: number }>(redisConfig.KEY);
    authPoolMax = authDb.poolMax;
    redisBoundMs = redisCfg.commandTimeoutMs + LATENCY_MARGIN_MS;
    // Đường xấu nhất: chờ connection (DB_AUTH_CONNECTION_TIMEOUT_MS) rồi probe S2-R45 (HEALTH_CHECK_TIMEOUT_MS).
    dbBoundMs =
      authDb.connectionTimeoutMs + health.checkTimeoutMs + LATENCY_MARGIN_MS;
  });
  afterEach(async () => {
    for (const s of logSpies)
      for (const args of s.mock.calls)
        logged.push(inspect(args, { depth: 12, breakLength: Infinity }));
    await restoreAll();
    expect(crashes).toEqual([]);
  });
  afterAll(async () => {
    await app?.close();
    await toxi?.stop();
    await mailpitC?.stop();
    await redis?.stop();
    await net?.stop();
    for (const s of logSpies) s.mockRestore();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
    vi.unstubAllEnvs();
  });

  it('Redis down: sign-in, /v1/me and 2FA still work within the Redis command timeout; limiters stay enforced; the verification email waits in the outbox and is sent exactly once after recovery', async () => {
    const outboxBase = await maxOutboxId();
    const deliveryBase = await maxDeliveryId();
    await redisProxy.setEnabled(false);
    const email = `r-${v7()}@example.test`;
    secrets.add(email);
    try {
      // Chỉ khẳng định sau khi client của app đã thấy Redis sập, nếu không request có thể chạy trước sự cố.
      await vi.waitFor(
        async () => expect(await redisAnswers()).toBe(false),
        WAIT,
      );
      const c = new AuthClient(server());
      const steps: [string, Timed, number][] = [
        ['sign-up', await timed(() => c.signUp(email, PASSWORD)), 202],
      ];
      await verifyEmailDirect(email);
      steps.push(
        ['sign-in', await timed(() => c.signIn(email, PASSWORD)), 200],
        ['/v1/me', await timed(() => c.request('get', '/v1/me')), 200],
        [
          '2fa enable',
          await timed(() =>
            c.request('post', '/api/auth/two-factor/enable', {
              body: { password: PASSWORD },
            }),
          ),
          200,
        ],
      );
      for (const v of c.cookies.values()) secrets.add(v);
      for (const [label, t, status] of steps) {
        expect(t.res.status, label).toBe(status);
        expect(t.ms, `${label} latency`).toBeLessThanOrEqual(redisBoundMs);
      }

      // Throttler theo route của SP1: insurance trong bộ nhớ tiếp quản, vẫn chặn (không fail-open). /v1/me đã tính 1.
      const route: number[] = [];
      for (let i = 1; i <= THROTTLE_LIMIT; i++) {
        const t = await timed(() => c.request('get', '/v1/me'));
        expect(t.ms).toBeLessThanOrEqual(redisBoundMs);
        route.push(t.res.status);
      }
      expect(route).toEqual([...Array(THROTTLE_LIMIT - 1).fill(200), 429]);

      // Giới hạn trước xác thực (S2-R51/R53): cùng storage, cùng insurance; key rác bị chặn trước khi chạm DB auth.
      const junk = new AuthClient(server());
      const pre: number[] = [];
      for (let i = 0; i <= PRE_AUTH_LIMIT; i++) {
        const t = await timed(() =>
          junk.request('get', '/v1/me', { cookie: false, apiKey: `junk-${i}` }),
        );
        expect(t.ms).toBeLessThanOrEqual(redisBoundMs);
        pre.push(t.res.status);
      }
      expect(pre).toEqual([...Array(PRE_AUTH_LIMIT).fill(401), 429]);

      // Thư chỉ bị hoãn: job gửi nằm trong outbox (chưa publish), delivery còn PENDING chưa claim lần nào.
      await sleep(MAIL_SETTLE_MS);
      expect(await unpublishedAfter(outboxBase)).toBeGreaterThan(0);
      const waiting = await deliveriesAfter(deliveryBase);
      // `/two-factor/enable` chỉ trả TOTP URI; thư "two-factor-changed" chỉ đi khi 2FA thật sự bật (verify-totp).
      expect(waiting.map((d) => [d.template, d.state, d.attempts])).toEqual([
        ['verify-email', 'PENDING', 0],
      ]);
      await redisProxy.setEnabled(true);
      await mailpit.waitFor(email, {
        subject: /Verify your email/,
        timeoutMs: MAIL_WAIT_MS,
      });
    } finally {
      await redisProxy.setEnabled(true);
    }
    await vi.waitFor(
      async () => {
        expect(
          (await deliveriesAfter(deliveryBase)).map((d) => d.state),
        ).toEqual(['SENT']);
        expect(await unpublishedAfter(outboxBase)).toBe(0);
      },
      { timeout: MAIL_WAIT_MS, interval: 200 },
    );
    await sleep(MAIL_SETTLE_MS);
    expect((await mailpit.messages(email)).map((m) => m.Subject)).toEqual([
      'Verify your email address',
    ]);
  });

  it('Redis blackholed (no RST): requests never wait past REDIS_COMMAND_TIMEOUT_MS, and queues deliver again once the path heals', async () => {
    const deliveryBase = await maxDeliveryId();
    const { email, c } = await newUser('rb');
    const toxic = await redisProxy.instance.addToxic<{ timeout: number }>({
      name: 'redis-blackhole',
      type: 'timeout',
      stream: 'upstream',
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    try {
      for (const [label, run, status] of [
        [
          'sign-in',
          () => new AuthClient(server()).signIn(email, PASSWORD),
          200,
        ],
        ['/v1/me (route throttler)', () => c.request('get', '/v1/me'), 200],
        [
          'junk api key (pre-auth limiter)',
          () =>
            new AuthClient(server()).request('get', '/v1/me', {
              cookie: false,
              apiKey: 'junk-blackhole',
            }),
          401,
        ],
      ] as const) {
        const t = await timed(run);
        expect(t.res.status, label).toBe(status);
        expect(t.ms, `${label} latency`).toBeLessThanOrEqual(redisBoundMs);
      }
    } finally {
      await toxic.remove();
    }
    await vi.waitFor(async () => expect(await redisAnswers()).toBe(true), WAIT);
    // Thư xác thực của user này (tạo ngay trước sự cố) vẫn tới: worker/relay không kẹt sau khi Redis bị blackhole.
    await mailpit.waitFor(email, {
      subject: /Verify your email/,
      timeoutMs: MAIL_WAIT_MS,
    });
    await vi.waitFor(
      async () =>
        expect(
          (await deliveriesAfter(deliveryBase)).map((d) => d.state),
        ).toEqual(['SENT']),
      WAIT,
    );
  });

  it('SMTP down within the retry budget: the job retries (PENDING between claims), the api stays ready, and after SMTP is back a reconcile racing the retry still delivers exactly once', async () => {
    const base = await maxDeliveryId();
    await smtpProxy.setEnabled(false);
    const email = `m-${v7()}@example.test`;
    secrets.add(email);
    let row: DeliveryRow | undefined;
    try {
      expect(
        (await new AuthClient(server()).signUp(email, PASSWORD)).status,
      ).toBe(202);
      // Lần claim đầu thất bại và nhả lease: PENDING, có mã lỗi SMTP, còn lượt thử (không FAILED).
      row = await vi.waitFor(async () => {
        const [r] = await deliveriesAfter(base);
        expect(r).toMatchObject({ template: 'verify-email', state: 'PENDING' });
        expect(SMTP_DOWN_CODES).toContain(r?.last_error_code);
        expect(r?.attempts).toBeGreaterThan(0);
        expect(r?.attempts).toBeLessThan(QUEUE_ATTEMPTS);
        return r;
      }, WAIT);
      const r = await ready();
      expect([r.status, r.body.status]).toEqual([200, 'ok']);
    } finally {
      await smtpProxy.setEnabled(true);
    }
    // Cron đối soát chạy trong lúc retry của BullMQ còn chờ: hai job (g0 retry, g1 đối soát) tranh cùng một delivery.
    await ownerQuery(
      `UPDATE email_deliveries SET last_enqueued_at = now() - interval '1 hour' WHERE public_id = $1 AND state = 'PENDING'`,
      [row?.public_id],
    );
    expect(await reconcile()).toEqual({ requeued: 1, failed: 0 });
    await mailpit.waitFor(email, {
      subject: /Verify your email/,
      timeoutMs: MAIL_WAIT_MS,
    });
    await sleep(MAIL_SETTLE_MS);
    const [done] = await deliveriesAfter(base);
    expect(done).toMatchObject({ state: 'SENT', enqueue_generation: 1 });
    expect(done?.attempts).toBeLessThanOrEqual(QUEUE_ATTEMPTS);
    expect(await mailpit.messages(email)).toHaveLength(1);
    // Đối soát sau khi đã SENT không gửi lại.
    expect(await reconcile()).toEqual({ requeued: 0, failed: 0 });
  });

  it('SMTP down past the retry budget: attempts stop at QUEUE_DEFAULT_ATTEMPTS, the breaker opens, deliveries end FAILED with an event, the api stays ready, and nothing is resent later', async () => {
    const base = await maxDeliveryId();
    await smtpProxy.setEnabled(false);
    const emails = [`x-${v7()}@example.test`, `y-${v7()}@example.test`];
    for (const e of emails) secrets.add(e);
    try {
      // Hai thư × QUEUE_ATTEMPTS lần thử = 6 lỗi liên tiếp > ngưỡng breaker (RESILIENCE_DEFAULT_BREAKER_THRESHOLD=5).
      const signUps = await Promise.all(
        emails.map((e) => new AuthClient(server()).signUp(e, PASSWORD)),
      );
      expect(signUps.map((s) => s.status)).toEqual([202, 202]);
      const rows = await vi.waitFor(async () => {
        const rs = await deliveriesAfter(base);
        expect(rs.map((d) => d.state)).toEqual(['FAILED', 'FAILED']);
        return rs;
      }, WAIT);
      expect(rows.map((d) => d.attempts)).toEqual([
        QUEUE_ATTEMPTS,
        QUEUE_ATTEMPTS,
      ]);
      for (const d of rows) {
        expect(SMTP_DOWN_CODES).toContain(d.last_error_code);
        expect(await failedEvents(d.public_id)).toBe(1);
      }
      // Lỗi thứ 5 liên tiếp mở breaker; RESILIENCE_DEFAULT_BREAKER_HALF_OPEN_MS (30 s) chưa trôi qua.
      expect(smtpBreaker()).toBe(CircuitState.Open);
      const r = await ready();
      expect([r.status, r.body.status]).toEqual([200, 'ok']);
    } finally {
      await smtpProxy.setEnabled(true);
    }
    await ownerQuery(
      `UPDATE email_deliveries SET last_enqueued_at = now() - interval '1 hour' WHERE id > $1::bigint`,
      [base],
    );
    expect(await reconcile()).toEqual({ requeued: 0, failed: 0 });
    await sleep(MAIL_SETTLE_MS);
    for (const e of emails) expect(await mailpit.messages(e)).toEqual([]);
  });

  it('auth DB cut: sign-in, sign-up, 2FA, get-session and cookie/bearer/API-key requests answer 503 with Retry-After within the pool timeouts, never 500 or 401; readiness auth_database goes 503 then back to 200', async () => {
    const { email, c } = await newUser('d');
    const bearer = c.bearer ?? '';
    expect(bearer).not.toBe('');
    const apiKey: string = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'chaos' },
      })
    ).body.key;
    secrets.add(apiKey);
    const warn = warnSpy;
    if (!warn) throw new Error('warn spy not installed');
    await authDbProxy.setEnabled(false);
    try {
      const probes: [string, () => Promise<Response>][] = [
        ['sign-in', () => new AuthClient(server()).signIn(email, PASSWORD)],
        [
          'sign-up',
          () =>
            new AuthClient(server()).signUp(
              `d2-${v7()}@example.test`,
              PASSWORD,
            ),
        ],
        [
          '2fa enable',
          () =>
            c.request('post', '/api/auth/two-factor/enable', {
              body: { password: PASSWORD },
            }),
        ],
        ['get-session', () => c.request('get', '/api/auth/get-session')],
        ['cookie /v1/me', () => c.request('get', '/v1/me')],
        [
          'bearer /v1/me',
          () =>
            new AuthClient(server()).request('get', '/v1/me', {
              cookie: false,
              bearer,
            }),
        ],
        [
          'api key /v1/me',
          () =>
            new AuthClient(server()).request('get', '/v1/me', {
              cookie: false,
              apiKey,
            }),
        ],
      ];
      for (const [label, run] of probes)
        expectUnavailable(label, await timed(run), dbBoundMs);

      warn.mockClear();
      const r = await timed(() => ready());
      expect([r.res.status, r.res.body.code]).toEqual([
        503,
        'service_unavailable',
      ]);
      expect(r.ms).toBeLessThanOrEqual(dbBoundMs);
      const readiness = warn.mock.calls.find(
        (a) =>
          typeof a[0] === 'object' &&
          a[0] !== null &&
          'cause' in a[0] &&
          inspect(a[0]).includes('auth_database'),
      );
      expect(readiness?.[0]).toMatchObject({
        cause: {
          info: { database: { status: 'up' } },
          error: { auth_database: { status: 'down' } },
        },
      });
    } finally {
      await authDbProxy.setEnabled(true);
    }
    // Phục hồi: readiness về 200, cùng cookie/bearer/API key dùng lại được (503 không được xoá cookie của client).
    await vi.waitFor(async () => {
      const r = await ready();
      expect([r.status, r.body.info?.auth_database?.status]).toEqual([
        200,
        'up',
      ]);
    }, WAIT);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect(
      (
        await new AuthClient(server()).request('get', '/v1/me', {
          cookie: false,
          bearer,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await new AuthClient(server()).request('get', '/v1/me', {
          cookie: false,
          apiKey,
        })
      ).status,
    ).toBe(200);
    expect(
      (await new AuthClient(server()).signIn(email, PASSWORD)).status,
    ).toBe(200);
  });

  it('auth DB cut mid-query (Kysely queries of Better Auth in flight): every request answers 503, the process does not crash, and the pool recovers without stuck clients', async () => {
    const { email, c } = await newUser('q');
    const p = pool();
    // Pool ấm: connection sẵn có, nên query đi ngay và nằm "trong dây" khi bị cắt.
    await Promise.all(
      Array.from({ length: authPoolMax }, () =>
        c.request('get', '/api/auth/get-session'),
      ),
    );
    const toxic = await authDbProxy.instance.addToxic<{
      latency: number;
      jitter: number;
    }>({
      name: 'authdb-latency',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1,
      attributes: { latency: DB_LATENCY_TOXIC_MS, jitter: 0 },
    });
    let cutAt = 0;
    try {
      const inflight = [
        timed(() => c.request('get', '/v1/me')),
        timed(() => c.request('get', '/api/auth/get-session')),
        timed(() => new AuthClient(server()).signIn(email, PASSWORD)),
      ];
      // Có client đang bị checkout (query đang chạy) thì mới cắt.
      await vi.waitFor(
        () => expect(p.totalCount - p.idleCount).toBeGreaterThan(0),
        WAIT,
      );
      cutAt = performance.now();
      await authDbProxy.setEnabled(false);
      const results = await Promise.all(inflight);
      for (const [i, t] of results.entries()) {
        expectUnavailable(`in-flight #${i}`, t, Number.POSITIVE_INFINITY);
        // Còn đang chạy lúc cắt (không phải 503 sớm vì hết chờ connection): đây đúng là cắt giữa query.
        expect(
          t.doneAt,
          `in-flight #${i} still running at the cut`,
        ).toBeGreaterThan(cutAt);
        expect(
          t.doneAt - cutAt,
          `in-flight #${i} after cut`,
        ).toBeLessThanOrEqual(dbBoundMs);
      }
    } finally {
      await toxic.remove();
      await authDbProxy.setEnabled(true);
    }
    await vi.waitFor(
      async () => expect((await ready()).status).toBe(200),
      WAIT,
    );
    // Không client nào kẹt: một loạt gấp đôi pool đều thành công, rồi mọi client đã trả về pool.
    const burst = await Promise.all(
      Array.from({ length: authPoolMax * 2 }, () =>
        c.request('get', '/api/auth/get-session'),
      ),
    );
    expect(burst.map((b) => b.status)).toEqual(
      Array(authPoolMax * 2).fill(200),
    );
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    await vi.waitFor(() => {
      expect(p.waitingCount).toBe(0);
      expect(p.totalCount - p.idleCount).toBe(0);
    }, WAIT);
    expect(p.totalCount).toBeLessThanOrEqual(authPoolMax);
  });

  it('no log line across every outage carries an email address, password, cookie, bearer token or API key', () => {
    const text = logged.join('\n');
    // Có log thật để soi (vd. `auth_unavailable`, `delivery_*`, readiness), không phải chuỗi rỗng.
    expect(text).toContain('auth_unavailable');
    const leaked = [...secrets].filter((s) => text.includes(s));
    expect(leaked).toEqual([]);
    expect(text).not.toMatch(/[a-z0-9-]+@example\.test/i);
  });
});
