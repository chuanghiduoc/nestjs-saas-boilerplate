import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { dbEnvFor } from './db.js';
import { readImages } from './images.js';
import type { Infra } from './infra.js';
import { migrateTestDb } from './migrate-test-db.js';

/** Tham số của bộ test (không phải config của app). */
const TEST_DB_TIMEOUTS = {
  userStatementMs: '5000',
  relayStatementMs: '60000',
  idleInTxMs: '10000',
};
const PG_ALIAS = 'pg';
/**
 * Windows NTFS không lưu bit thực thi Unix, nên fs.stat() trên host Windows không
 * phản ánh đúng quyền +x của docker/postgres/init/01-roles.sh (git ghi 100755 trong
 * index, nhưng đó là quyền lưu trong git object, không phải quyền filesystem thật khi
 * checkout trên Windows). testcontainers/archiver hỗ trợ ép mode tường minh khi build
 * tar (DirectoryToCopy.mode được ưu tiên hơn stats.mode trong archiver-utils), nên ép
 * 0755 ở đây để script vẫn thực thi được bên trong container Linux bất kể host OS.
 */
const INIT_SCRIPT_MODE = 0o755;
const secret = () => randomBytes(18).toString('base64url');

let network: StartedNetwork | undefined;
let pgC: StartedPostgreSqlContainer | undefined;
let bouncer: StartedTestContainer | undefined;
let redisC: StartedRedisContainer | undefined;

export async function setup(project: TestProject) {
  const images = readImages();
  const owner = { user: 'app_owner', password: secret() };
  const app = { user: 'app_user', password: secret() };
  const relay = { user: 'app_relay', password: secret() };
  network = await new Network().start();
  pgC = await new PostgreSqlContainer(images.IMAGE_POSTGRES!)
    .withNetwork(network)
    .withNetworkAliases(PG_ALIAS)
    .withEnvironment({
      APP_OWNER_PASSWORD: owner.password,
      APP_USER_PASSWORD: app.password,
      APP_RELAY_PASSWORD: relay.password,
      APP_USER_STATEMENT_TIMEOUT_MS: TEST_DB_TIMEOUTS.userStatementMs,
      APP_RELAY_STATEMENT_TIMEOUT_MS: TEST_DB_TIMEOUTS.relayStatementMs,
      IDLE_IN_TX_TIMEOUT_MS: TEST_DB_TIMEOUTS.idleInTxMs,
    })
    .withCopyDirectoriesToContainer([
      {
        source: resolve('docker/postgres/init'),
        target: '/docker-entrypoint-initdb.d',
        mode: INIT_SCRIPT_MODE,
      },
    ])
    .start();
  bouncer = await new GenericContainer(images.IMAGE_PGBOUNCER!)
    .withNetwork(network)
    .withEnvironment({
      DB_HOST: PG_ALIAS,
      DB_PORT: '5432',
      DB_NAME: pgC.getDatabase(),
      DB_USER: app.user,
      DB_PASSWORD: app.password,
      POOL_MODE: 'transaction',
      AUTH_TYPE: 'scram-sha-256',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  redisC = await new RedisContainer(images.IMAGE_REDIS!).start();
  const infra: Infra = {
    pg: {
      host: pgC.getHost(),
      port: pgC.getPort(),
      database: pgC.getDatabase(),
      owner,
      app,
      relay,
    },
    pgbouncer: { host: bouncer.getHost(), port: bouncer.getMappedPort(5432) },
    redis: { url: redisC.getConnectionUrl() },
  };
  // Migrate một lần cho cả bộ test; file test không tự chạy `up` trong beforeAll.
  Object.assign(process.env, dbEnvFor(infra));
  try {
    await migrateTestDb();
  } catch (err) {
    // Không để container mồ côi khi migrate lỗi; lỗi gốc vẫn được ném ra.
    await teardown();
    throw err;
  }
  project.provide('infra', infra);
}

export async function teardown() {
  await redisC?.stop();
  await bouncer?.stop();
  await pgC?.stop();
  await network?.stop();
}
