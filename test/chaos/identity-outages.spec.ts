import { inspect } from 'node:util';
import { Logger, type INestApplication } from '@nestjs/common';
import {
  ToxiProxyContainer,
  type CreatedProxy,
  type StartedToxiProxyContainer,
} from '@testcontainers/toxiproxy';
import { BrokenCircuitError } from 'cockatiel';
import pg from 'pg';
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
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { ConfigOf } from '../../src/core/config/index.js';
import { healthConfig } from '../../src/core/health/index.js';
import {
  REDIS,
  redisConfig,
  type RedisClient,
} from '../../src/core/redis/index.js';
import {
  ResiliencePolicies,
  resilienceConfig,
} from '../../src/core/resilience/index.js';
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
 * - DB only, `LATENCY_MARGIN_MS`: phần cộng thêm vào timeout đã cấu hình khi đo thời gian trả lời (supertest, event loop, và
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
const REDIS_LATENCY_MARGIN_FRACTION = 0.5;
/**
 * Số lệnh Redis nối tiếp một request trả qua khi Redis bị blackhole (mỗi lệnh chờ đủ REDIS_COMMAND_TIMEOUT_MS rồi
 * rơi sang insurance). Đo được (commandTimeout 1000 ms): sign-in ~0.5 s, cookie `/v1/me` ~1.1 s, key rác ~2.1 s,
 * key hợp lệ ~3.2 s.
 * - Cookie/bearer: throttler theo route (`AppThrottlerGuard`) — 1. Sign-in không qua guard; trần 1 là mức trần.
 * - API key rác: `PreAuthRateLimiter.consume` ở middleware + throttler theo route ở guard (S2-R51) — 2.
 * - API key hợp lệ: `consume` + `refund` (S2-R53) + throttler theo route — 3.
 * Bound = số lệnh + REDIS_LATENCY_MARGIN_FRACTION timeout: thêm một lệnh Redis nối tiếp vào bất kỳ đường nào là đỏ.
 */
const REDIS_ROUND_TRIPS = { session: 1, junkApiKey: 2, validApiKey: 3 };
const THROTTLE_LIMIT = 6;
const PRE_AUTH_LIMIT = 4;
const MAIL_SETTLE_MS = 3000;
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

/**
 * Backend của `user` đang chờ lock mà `lock` giữ, tức là đang chạy một câu lệnh bị chặn giữa chừng.
 * - Không lọc `state`/`wait_event_type`: `app_owner` không có `pg_read_all_stats`, nên với backend của role khác
 *   PostgreSQL trả NULL cho các cột đó (cùng `query = '<insufficient privilege>'`). `usename` và `pg_blocking_pids`
 *   thì vẫn đọc được, và `pg_blocking_pids` chỉ chứa pid của `lock` khi backend kia đang chờ lock của nó.
 * - `pg_stat_clear_snapshot()` trước mỗi lần đọc: `pg_stat_activity` bị chụp một lần mỗi transaction (barrier giữ
 *   transaction mở suốt quá trình poll), `stats_fetch_consistency` không áp dụng cho nó.
 */
const blockedQueries = async (
  lock: pg.Client,
  user: string,
): Promise<number> => {
  await lock.query('SELECT pg_stat_clear_snapshot()');
  const result = await lock.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND usename = $1
       AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`,
    [user],
  );
  return result.rows[0]?.n ?? 0;
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
  let baseUrl: string;
  let redisCommandTimeoutMs = 0;
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

  const server = () => baseUrl;
  /** Trần độ trễ của một request trả `roundTrips` lệnh Redis nối tiếp (xem REDIS_ROUND_TRIPS). */
  const redisBoundMs = (roundTrips: number) =>
    redisCommandTimeoutMs * (roundTrips + REDIS_LATENCY_MARGIN_FRACTION);
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
  const cutBlockedQuery = async (
    label: string,
    run: () => Promise<Response>,
  ) => {
    const { pg: db } = getInfra();
    const lock = new pg.Client({
      host: db.host,
      port: db.port,
      database: db.database,
      ...db.owner,
    });
    let inflight: Promise<Timed> | undefined;
    try {
      await lock.connect();
      await lock.query('BEGIN');
      await lock.query(
        'LOCK TABLE auth."user", auth.session IN ACCESS EXCLUSIVE MODE',
      );
      // Each request runs alone. PostgreSQL proves its query is executing and
      // blocked by this transaction, not merely waiting to acquire a pool client.
      let settled = false;
      inflight = timed(run).finally(() => {
        settled = true;
      });
      // Attach a rejection handler immediately; await inflight still propagates errors.
      void Promise.allSettled([inflight]);
      await vi.waitFor(async () => {
        expect(settled, `${label} finished before the query barrier`).toBe(
          false,
        );
        expect(
          await blockedQueries(lock, db.auth.user),
          `${label} blocked inside PostgreSQL`,
        ).toBe(1);
      }, WAIT);
      expect(settled).toBe(false);
      const cutAt = performance.now();
      await authDbProxy.setEnabled(false);
      const t = await inflight;
      expectUnavailable(label, { ...t, ms: t.doneAt - cutAt }, dbBoundMs);
      expect(t.doneAt, `${label} completed after sever`).toBeGreaterThan(cutAt);
    } finally {
      // Closing the owner connection releases transaction locks on every exit.
      try {
        await lock.end();
      } finally {
        await authDbProxy.setEnabled(true);
        if (inflight) await Promise.allSettled([inflight]);
      }
    }
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
  });
  beforeEach(async () => {
    crashes.length = 0;
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
    // One listening server avoids supertest attaching close listeners per concurrent request.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    const authDb = app.get<ConfigOf<typeof authDatabaseConfig>>(
      authDatabaseConfig.KEY,
    );
    const health = app.get<ConfigOf<typeof healthConfig>>(healthConfig.KEY);
    const redisCfg = app.get<ConfigOf<typeof redisConfig>>(redisConfig.KEY);
    authPoolMax = authDb.poolMax;
    redisCommandTimeoutMs = redisCfg.commandTimeoutMs;
    // Đường xấu nhất: chờ connection (DB_AUTH_CONNECTION_TIMEOUT_MS) rồi probe S2-R45 (HEALTH_CHECK_TIMEOUT_MS).
    dbBoundMs =
      authDb.connectionTimeoutMs + health.checkTimeoutMs + LATENCY_MARGIN_MS;
  });
  afterEach(async () => {
    try {
      await restoreAll();
    } finally {
      // Rebuild per test so SMTP breaker, limiter and worker state cannot leak.
      try {
        await app?.close();
      } finally {
        for (const s of logSpies)
          for (const args of s.mock.calls)
            logged.push(inspect(args, { depth: 12, breakLength: Infinity }));
        expect(crashes.splice(0)).toEqual([]);
      }
    }
  });
  afterAll(async () => {
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
      const twoFactor: unknown = steps.find(
        ([label]) => label === '2fa enable',
      )?.[1].res.body;
      if (
        !twoFactor ||
        typeof twoFactor !== 'object' ||
        !('totpURI' in twoFactor) ||
        typeof twoFactor.totpURI !== 'string' ||
        !('backupCodes' in twoFactor) ||
        !Array.isArray(twoFactor.backupCodes)
      )
        throw new Error('2FA enable must return a TOTP URI and backup codes');
      const secret = new URL(twoFactor.totpURI).searchParams.get('secret');
      if (!secret || twoFactor.backupCodes.length === 0)
        throw new Error('2FA material must not be empty');
      secrets.add(twoFactor.totpURI);
      secrets.add(secret);
      for (const code of twoFactor.backupCodes) {
        if (typeof code !== 'string' || !code)
          throw new Error('Invalid backup code');
        secrets.add(code);
      }
      for (const v of c.cookies.values()) secrets.add(v);
      for (const [label, t, status] of steps) {
        expect(t.res.status, label).toBe(status);
        expect(t.ms, `${label} latency`).toBeLessThanOrEqual(
          redisBoundMs(REDIS_ROUND_TRIPS.session),
        );
      }

      // Throttler theo route của SP1: insurance trong bộ nhớ tiếp quản, vẫn chặn (không fail-open). /v1/me đã tính 1.
      const route: number[] = [];
      for (let i = 1; i <= THROTTLE_LIMIT; i++) {
        const t = await timed(() => c.request('get', '/v1/me'));
        expect(t.ms).toBeLessThanOrEqual(
          redisBoundMs(REDIS_ROUND_TRIPS.session),
        );
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
        expect(t.ms).toBeLessThanOrEqual(
          redisBoundMs(REDIS_ROUND_TRIPS.junkApiKey),
        );
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

  it('Redis blackholed (no RST): each request pays at most its named number of Redis command timeouts, and queues deliver again once the path heals', async () => {
    const deliveryBase = await maxDeliveryId();
    const { email, c } = await newUser('rb');
    const apiKey: string = (
      await c.request('post', '/api/auth/api-key/create', {
        body: { name: 'chaos-blackhole' },
      })
    ).body.key;
    secrets.add(apiKey);
    const toxic = await redisProxy.instance.addToxic<{ timeout: number }>({
      name: 'redis-blackhole',
      type: 'timeout',
      stream: 'upstream',
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    try {
      for (const [label, run, status, roundTrips] of [
        [
          'sign-in',
          () => new AuthClient(server()).signIn(email, PASSWORD),
          200,
          REDIS_ROUND_TRIPS.session,
        ],
        [
          '/v1/me (route throttler)',
          () => c.request('get', '/v1/me'),
          200,
          REDIS_ROUND_TRIPS.session,
        ],
        [
          'junk api key (pre-auth limiter + route throttler)',
          () =>
            new AuthClient(server()).request('get', '/v1/me', {
              cookie: false,
              apiKey: 'junk-blackhole',
            }),
          401,
          REDIS_ROUND_TRIPS.junkApiKey,
        ],
        [
          'valid api key (pre-auth consume + refund + route throttler)',
          () =>
            new AuthClient(server()).request('get', '/v1/me', {
              cookie: false,
              apiKey,
            }),
          200,
          REDIS_ROUND_TRIPS.validApiKey,
        ],
      ] as const) {
        const t = await timed(run);
        expect(t.res.status, label).toBe(status);
        expect(t.ms, `${label} latency`).toBeLessThanOrEqual(
          redisBoundMs(roundTrips),
        );
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
    await ownerQuery(
      `UPDATE email_deliveries SET last_enqueued_at = now() - interval '1 hour' WHERE public_id = $1 AND state = 'PENDING'`,
      [row?.public_id],
    );
    // Retry may claim/send first (0), or reconcile may enqueue generation 1.
    // The persisted generation must match the winner; either path sends exactly once.
    const reconciled = await reconcile();
    expect(reconciled.failed).toBe(0);
    expect([0, 1]).toContain(reconciled.requeued);
    await mailpit.waitFor(email, {
      subject: /Verify your email/,
      timeoutMs: MAIL_WAIT_MS,
    });
    await sleep(MAIL_SETTLE_MS);
    const [done] = await deliveriesAfter(base);
    expect(done).toMatchObject({
      state: 'SENT',
      enqueue_generation: reconciled.requeued,
    });
    expect(done?.attempts).toBeLessThanOrEqual(QUEUE_ATTEMPTS);
    expect(await mailpit.messages(email)).toHaveLength(1);
    // Đối soát sau khi đã SENT không gửi lại.
    expect(await reconcile()).toEqual({ requeued: 0, failed: 0 });
  });

  it('SMTP down past the retry budget: attempts stop at QUEUE_DEFAULT_ATTEMPTS, the breaker opens, deliveries end FAILED with an event, the api stays ready, and nothing is resent later', async () => {
    const base = await maxDeliveryId();
    await smtpProxy.setEnabled(false);
    const cfg = app.get<ConfigOf<typeof resilienceConfig>>(
      resilienceConfig.KEY,
    );
    const threshold =
      cfg.overrides[SMTP_RESILIENCE_PROVIDER]?.breakerThreshold ??
      cfg.breakerThreshold;
    const emails = Array.from(
      { length: Math.ceil(threshold / QUEUE_ATTEMPTS) },
      () => `x-${v7()}@example.test`,
    );
    for (const e of emails) secrets.add(e);
    try {
      const signUps = await Promise.all(
        emails.map((e) => new AuthClient(server()).signUp(e, PASSWORD)),
      );
      expect(signUps.map((s) => s.status)).toEqual(emails.map(() => 202));
      const rows = await vi.waitFor(async () => {
        const rs = await deliveriesAfter(base);
        expect(rs.map((d) => d.state)).toEqual(emails.map(() => 'FAILED'));
        return rs;
      }, WAIT);
      expect(rows.map((d) => d.attempts)).toEqual(
        emails.map(() => QUEUE_ATTEMPTS),
      );
      for (const d of rows) {
        expect(SMTP_DOWN_CODES).toContain(d.last_error_code);
        expect(await failedEvents(d.public_id)).toBe(1);
      }
      // Public API: an open circuit rejects without invoking the callback.
      const probe = vi.fn();
      await expect(
        app
          .get(ResiliencePolicies)
          .for(SMTP_RESILIENCE_PROVIDER)
          .single.execute(probe),
      ).rejects.toBeInstanceOf(BrokenCircuitError);
      expect(probe).not.toHaveBeenCalled();
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

      // Preserve outage logs before isolating the readiness assertion below.
      for (const args of warn.mock.calls)
        logged.push(inspect(args, { depth: 12, breakLength: Infinity }));
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
    const probes: [string, () => Promise<Response>][] = [
      ['/v1/me', () => c.request('get', '/v1/me')],
      ['get-session', () => c.request('get', '/api/auth/get-session')],
      ['sign-in', () => new AuthClient(server()).signIn(email, PASSWORD)],
    ];
    for (const [label, run] of probes) {
      await cutBlockedQuery(label, run);
      await vi.waitFor(
        async () => expect((await ready()).status).toBe(200),
        WAIT,
      );
    }
    // A burst larger than the pool proves clients are released after recovery.
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

  it('no captured Nest log across every outage carries credentials, TOTP secrets or backup codes', () => {
    // startIdentityApp does not import LoggingModule or install nestjs-pino.
    // Nest logs only: pino JSON/request redaction requires the production harness.
    const text = logged.join('\n');
    // Có log thật để soi (vd. `auth_unavailable`, `delivery_*`, readiness), không phải chuỗi rỗng.
    expect(text).toContain('auth_unavailable');
    const leaked = [...secrets].filter((s) => text.includes(s));
    expect(leaked).toEqual([]);
    expect(text).not.toMatch(/[a-z0-9-]+@example\.test/i);
  });
});
