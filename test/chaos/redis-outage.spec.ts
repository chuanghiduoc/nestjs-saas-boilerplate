import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import {
  ToxiProxyContainer,
  type CreatedProxy,
  type StartedToxiProxyContainer,
} from '@testcontainers/toxiproxy';
import { DatabaseModule, RelayDb } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { HealthModule } from '../../src/core/health/index.js';
import {
  HttpModule,
  Idempotent,
  applyHttpDefaults,
} from '../../src/core/http/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import {
  REDIS,
  RedisModule,
  type RedisClient,
} from '../../src/core/redis/index.js';
import { FixtureNotesModule } from '../fixtures/fixture.controller.js';
import {
  AuditSubscriber,
  MailerSubscriber,
  received,
} from '../fixtures/fixture.events.js';
import { createTestApp } from '../support/app-factory.js';
import { readImages } from '../support/images.js';
import { TestPrincipalModule } from '../support/test-principal.middleware.js';

@Module({ providers: [AuditSubscriber, MailerSubscriber] })
class Subs {}
@Controller('chaos')
class ChaosRoutes {
  @Get('ping') ping() {
    return { ok: true };
  }
  @Post('pay') @HttpCode(201) @Idempotent() pay(@Body() b: { amount: number }) {
    return { amount: b.amount };
  }
}
@Module({ controllers: [ChaosRoutes] })
class Routes {}

/** Tham số của bộ test (không phải config của app). */
const OUTAGE_MS = 10_000;
const EVENTS = 20;
const REDIS_PORT = 6379;
/** Hạn mức rate limit nhỏ để chứng minh insurance limiter thật sự chặn (429) khi Redis sập. */
const RATE_LIMIT = 5;
const RECOVERY_TIMEOUT_MS = 120_000;
const POLL_MS = 200;
const INSURANCE_WARN = 'per-process insurance limiter in use';
const RECOVERED_LOG = 'redis recovered for rate limiting';

const until = async (pred: () => boolean | Promise<boolean>, ms: number) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};
const mentions = (args: readonly unknown[], text: string) =>
  args.some((a) => typeof a === 'string' && a.includes(text));

describe('redis outage', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;

  const started = (): INestApplication => {
    if (!app) throw new Error('app not started');
    return app;
  };
  const http = () => request(started().getHttpServer());
  const ping = (principal: string) =>
    http().get('/chaos/ping').set('x-test-principal', principal);
  /** Bật/tắt đường tới Redis (Toxiproxy đóng connection đang mở và từ chối connection mới). */
  const setRedisUp = async (up: boolean): Promise<void> => {
    if (!proxy) throw new Error('toxiproxy not started');
    await proxy.setEnabled(up);
  };
  /** Điều kiện chờ: Redis trả lời qua client của app. Lỗi lúc Redis còn sập nghĩa là "chưa". */
  const redisAnswers = async (): Promise<boolean> => {
    try {
      return (await started().get<RedisClient>(REDIS).ping()) === 'PONG';
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    const images = readImages();
    const redisImage = images.IMAGE_REDIS;
    const toxiImage = images.IMAGE_TOXIPROXY;
    if (!redisImage || !toxiImage)
      throw new Error(
        'IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env',
      );
    network = await new Network().start();
    redis = await new GenericContainer(redisImage)
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(REDIS_PORT)
      .start();
    toxi = await new ToxiProxyContainer(toxiImage).withNetwork(network).start();
    const created = await toxi.createProxy({
      name: 'redis',
      upstream: `redis:${REDIS_PORT}`,
    });
    proxy = created;
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('REDIS_URL', `redis://${created.host}:${created.port}`);
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '200');
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', String(RATE_LIMIT));
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '100');
    app = await createTestApp(
      [
        DatabaseModule.forRoot({ relay: true }),
        RedisModule,
        QueueModule.forRoot({ runWorkers: true }),
        OutboxModule.forRoot({ relay: true }),
        EventsModule.forRoot({ worker: true }),
        FixtureNotesModule,
        Subs,
        HttpModule,
        // Readiness của api (http: true): chỉ DB, theo ruling R21.
        HealthModule.forRoot({ http: true }),
        TestPrincipalModule,
        Routes,
      ],
      { beforeInit: applyHttpDefaults },
    );
  });
  afterEach(async () => {
    // Test lỗi giữa chừng không được để Redis "sập" sang test sau.
    await proxy?.setEnabled(true);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    // Dọn theo thứ tự ngược lại kể cả khi beforeAll dừng giữa chừng.
    await app?.close();
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('commands keep succeeding while Redis is down and events are delivered exactly once after recovery', async () => {
    received.length = 0;
    const bodies = Array.from(
      { length: EVENTS },
      (_, i) => `outage-${Date.now()}-${i}`,
    );
    await setRedisUp(false);

    // Mỗi lệnh một principal: bucket rate limit riêng, hạn mức nhỏ của bộ test không chặn lệnh.
    for (const [i, body] of bodies.entries())
      await http()
        .post('/fixture/notes')
        .set('x-test-principal', `user:outage-${i}`)
        .send({ body })
        .expect(201);

    const pending = async () => {
      const [row] = await started().get(RelayDb).execute<{
        n: string;
      }>(`SELECT count(*)::text AS n FROM outbox_events WHERE published_at IS NULL AND payload->>'body' IN (?)`, [bodies]);
      return Number(row?.n ?? 0);
    };
    await new Promise((r) => setTimeout(r, OUTAGE_MS));
    expect(await pending()).toBe(EVENTS);

    await setRedisUp(true);
    await until(
      () =>
        bodies.every((b) => received.filter((r) => r.body === b).length === 2),
      RECOVERY_TIMEOUT_MS,
    );
    await until(async () => (await pending()) === 0, 30_000);

    const pairs = received
      .filter((r) => bodies.includes(r.body))
      .map((r) => `${r.consumer}:${r.eventId}`);
    expect(pairs).toHaveLength(EVENTS * 2);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('rate limiting falls back to the in-memory insurance limiter, warns once per outage and recovers by itself', async () => {
    // Bắt đầu từ trạng thái Redis đang đếm được: client đã kết nối lại sau đợt sự cố của test
    // trước, rồi một request được Redis đếm để đóng đợt sự cố đó (nếu còn mở).
    await until(redisAnswers, RECOVERY_TIMEOUT_MS);
    await ping('user:rl-warmup').expect(200);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const log = vi.spyOn(Logger.prototype, 'log');
    const recovered = () =>
      log.mock.calls.some((args) => mentions(args, RECOVERED_LOG));

    await setRedisUp(false);
    await until(async () => !(await redisAnswers()), RECOVERY_TIMEOUT_MS);
    // Hạn mức vẫn được áp khi Redis sập (insurance trong process), không mở toang (fail-open).
    for (let i = 0; i < RATE_LIMIT; i++)
      await ping('user:rl-outage').expect(200);
    await ping('user:rl-outage').expect(429);
    const warns = warn.mock.calls.filter((args) =>
      mentions(args, INSURANCE_WARN),
    );
    expect(warns).toHaveLength(1);
    await setRedisUp(true);

    // Tự phục hồi: ioredis kết nối lại, request tiếp theo được Redis đếm và đợt sự cố đóng lại.
    let n = 0;
    await until(async () => {
      await ping(`user:rl-recover-${n++}`).expect(200);
      return recovered();
    }, RECOVERY_TIMEOUT_MS);
  });

  it('readiness stays 200 while Redis is down (api readiness checks the DB only)', async () => {
    await setRedisUp(false);
    // Chỉ khẳng định sau khi client của app đã thấy Redis sập, nếu không probe có thể chạy trước.
    await until(async () => !(await redisAnswers()), RECOVERY_TIMEOUT_MS);
    const res = await http().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('idempotent routes fail closed with 503 while Redis is down', async () => {
    await setRedisUp(false);
    await until(async () => !(await redisAnswers()), RECOVERY_TIMEOUT_MS);
    const res = await http()
      .post('/chaos/pay')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', `chaos-key-${Date.now()}-xxxxxxxx`)
      .set('x-test-principal', 'user:chaos')
      .send({ amount: 1 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');
  });
});
