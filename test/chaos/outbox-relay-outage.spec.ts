import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { v7 } from 'uuid';
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
import { DatabaseModule, UnitOfWork } from '../../src/core/database/index.js';
import {
  OutboxModule,
  OutboxRelay,
  OutboxWriter,
} from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { createTestApp } from '../support/app-factory.js';
import { readImages } from '../support/images.js';
import { getInfra } from '../support/infra.js';

/** Tham số của bộ test (không phải config của app). */
const REDIS_PORT = 6379;
const ENQUEUE_TIMEOUT_MS = 2_000;
const CLAIM_LEASE_MS = 4_000;
/**
 * Pool relay nhỏ nhất để một connection bị rò là đủ làm relay kẹt hẳn. Với code cũ, chỉ lần gọi
 * đầu tiên trên một `Queue` BullMQ mới tạo mới chờ Redis không giới hạn (`RedisConnection.init`
 * chờ 'ready' một lần; sau đó `commandTimeout` của ioredis chặn mỗi lệnh),
 * nên mỗi app chỉ rò được một connection do Redis sập.
 */
const LEAK_TEST_RELAY_POOL_MAX = 1;
const DEFAULT_RELAY_POOL_MAX = 2;
/**
 * Dài hơn `idle_in_transaction_session_timeout` của DB test (10s, `infra.global-setup.ts`):
 * relay nào còn giữ transaction qua lúc chờ Redis sẽ bị Postgres giết session.
 */
const OUTAGE_MS = 11_000;
/** Nhiều hơn số connection của pool relay. */
const OUTAGE_CYCLES = LEAK_TEST_RELAY_POOL_MAX + 2;
const RETURN_SLACK_MS = 1_500;
const RECOVERY_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>, ms: number) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await sleep(POLL_MS);
  }
};
/** Kết quả của `p` (lỗi cũng là kết quả), hoặc 'timeout' nếu quá `ms`. Timer luôn được huỷ. */
const within = async <T>(p: Promise<T>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p.catch((err: unknown) => err), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

describe('outbox relay during a Redis outage', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;
  /**
   * Quan sát bằng một session `app_relay` riêng, KHÔNG lấy từ pool relay đang bị kiểm tra: pool
   * cạn thì phép quan sát vẫn chạy (và cùng role nên đọc được `state` trong pg_stat_activity).
   */
  let observer: Client | undefined;

  const observe = (): Client => {
    if (!observer) throw new Error('observer not connected');
    return observer;
  };
  const started = (): INestApplication => {
    if (!app) throw new Error('app not started');
    return app;
  };
  const setRedisUp = async (up: boolean): Promise<void> => {
    if (!proxy) throw new Error('toxiproxy not started');
    await proxy.setEnabled(up);
  };
  const relay = () => started().get(OutboxRelay);
  const append = async (): Promise<string> => {
    const eventId = v7();
    await started()
      .get(UnitOfWork)
      .run(() =>
        started()
          .get(OutboxWriter)
          .append({
            eventId,
            type: 'test.relay.outage',
            version: 1,
            orgId: null,
            aggregate: { type: 'thing', id: '1', version: 1 },
            payload: {},
            headers: {},
          }),
      );
    return eventId;
  };
  const published = async (eventId: string): Promise<boolean> => {
    const {
      rows: [row],
    } = await observe().query<{ published: boolean }>(
      'SELECT published_at IS NOT NULL AS published FROM outbox_events WHERE event_id = $1',
      [eventId],
    );
    if (!row) throw new Error(`outbox row ${eventId} not found`);
    return row.published;
  };
  /** Session của role relay đang mở transaction mà không chạy lệnh nào (đúng thứ Postgres sẽ giết). */
  const idleInTransaction = async (): Promise<number> => {
    const {
      rows: [row],
    } = await observe().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE usename = current_user AND pid <> pg_backend_pid()
         AND state LIKE 'idle in transaction%'`,
    );
    if (!row) throw new Error('pg_stat_activity returned no row');
    return row.n;
  };

  /**
   * App mới cho mỗi test: `Queue` của BullMQ được tạo lần đầu trong lúc Redis sập (đúng tình huống
   * worker khởi động hoặc relay publish lần đầu khi Redis đang sập) và pool relay còn nguyên.
   */
  const boot = async (relayPoolMax: number): Promise<void> => {
    vi.stubEnv('DB_RELAY_POOL_MAX', String(relayPoolMax));
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: true }),
    ]);
  };

  beforeAll(async () => {
    const images = readImages();
    const redisImage = images.IMAGE_REDIS;
    const toxiImage = images.IMAGE_TOXIPROXY;
    if (!redisImage || !toxiImage)
      throw new Error(
        'IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env',
      );
    const { pg } = getInfra();
    observer = new Client({
      host: pg.host,
      port: pg.port,
      database: pg.database,
      ...pg.relay,
    });
    await observer.connect();
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
    vi.stubEnv('OUTBOX_AUTOSTART', 'false');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '200');
    vi.stubEnv('OUTBOX_ERROR_BACKOFF_MAX_MS', '1000');
    vi.stubEnv('OUTBOX_ENQUEUE_TIMEOUT_MS', String(ENQUEUE_TIMEOUT_MS));
    vi.stubEnv('OUTBOX_CLAIM_LEASE_MS', String(CLAIM_LEASE_MS));
  });
  afterEach(async () => {
    // Test lỗi giữa chừng không được để Redis "sập" sang test sau.
    await proxy?.setEnabled(true);
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    await observer?.end();
    vi.unstubAllEnvs();
  });

  it('a batch returns within the enqueue timeout while Redis is down, holds no transaction, and publishes after recovery', async () => {
    await boot(DEFAULT_RELAY_POOL_MAX);
    await setRedisUp(false);
    const eventId = await append();
    const samples: number[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        samples.push(await idleInTransaction());
        await sleep(POLL_MS);
      }
    })();
    const t = Date.now();
    const outcome = await within(
      relay().runOnce(),
      ENQUEUE_TIMEOUT_MS + RETURN_SLACK_MS,
    );
    const elapsedMs = Date.now() - t;
    sampling = false;
    await sampler;

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/enqueue timed out/);
    expect(elapsedMs).toBeGreaterThanOrEqual(ENQUEUE_TIMEOUT_MS);
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.max(...samples)).toBe(0);
    expect(await idleInTransaction()).toBe(0);
    expect(await published(eventId)).toBe(false);

    await setRedisUp(true);
    await until(async () => {
      await relay()
        .drain()
        .catch(() => 0);
      return published(eventId);
    }, RECOVERY_TIMEOUT_MS);
  });

  it(`the relay loop survives ${OUTAGE_CYCLES} outages longer than idle_in_transaction_session_timeout (more than the relay pool of ${LEAK_TEST_RELAY_POOL_MAX}) and keeps publishing`, async () => {
    await boot(LEAK_TEST_RELAY_POOL_MAX);
    relay().start();
    let maxIdle = 0;
    for (let i = 0; i < OUTAGE_CYCLES; i++) {
      await setRedisUp(false);
      const eventId = await append();
      const outageEnds = Date.now() + OUTAGE_MS;
      while (Date.now() < outageEnds) {
        maxIdle = Math.max(maxIdle, await idleInTransaction());
        await sleep(POLL_MS);
      }
      expect(await published(eventId)).toBe(false);
      await setRedisUp(true);
      await until(() => published(eventId), RECOVERY_TIMEOUT_MS);
    }
    const last = await append();
    await until(() => published(last), RECOVERY_TIMEOUT_MS);
    expect(maxIdle).toBe(0);
    expect(await idleInTransaction()).toBe(0);
  });
});
