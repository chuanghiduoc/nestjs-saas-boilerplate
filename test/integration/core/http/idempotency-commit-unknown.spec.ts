import {
  Controller,
  Headers,
  HttpCode,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CorePools,
  DatabaseModule,
  Db,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  HttpModule,
  Idempotent,
  applyHttpDefaults,
} from '../../../../src/core/http/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../../support/tcp-proxy.js';
import { TestPrincipalModule } from '../../../support/test-principal.middleware.js';

/** Deadline nhỏ để ca COMMIT rơi vào blackhole xong nhanh; luật production (connect + 2 × query < budget) vẫn đạt. */
const QUERY_TIMEOUT_MS = 400;
const CONNECTION_TIMEOUT_MS = 300;
const REQUEST_BUDGET_MS = 3000;
const LATENCY_MARGIN_MS = 1000;
/** Câu vượt QUERY_TIMEOUT_MS: `Query read timeout` → 503 service_unavailable, không ghi gì. */
const SLOW_SQL = 'select pg_sleep(1)';
const PRINCIPAL = 'user:u1';

let parentId = '';
let calls = 0;
let slowOnce = false;

/**
 * Route `@Idempotent()` viết đúng hợp đồng của ADR 0007: ghi idempotent trong DB theo Idempotency-Key (UNIQUE
 * `fixture_children.email` mang key), chạy lại thì trả đúng dòng đã có.
 */
@Controller('api/v1/orders')
class OrdersController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
  ) {}

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@Headers('idempotency-key') key: string) {
    calls++;
    const email = `${key}@idem.test`;
    return this.uow.run(async () => {
      const [created] = await this.db.execute<{ id: string }>(
        `INSERT INTO fixture_children (parent_id, email, qty) VALUES (?::bigint, ?, 1)
         ON CONFLICT (email) DO NOTHING RETURNING id::text AS id`,
        [parentId, email],
      );
      if (created) return { id: created.id };
      const [existing] = await this.db.execute<{ id: string }>(
        'SELECT id::text AS id FROM fixture_children WHERE email = ?',
        [email],
      );
      if (!existing) throw new Error('order vanished');
      return { id: existing.id };
    });
  }

  @Post('flaky')
  @HttpCode(201)
  @Idempotent()
  async flaky() {
    calls++;
    if (slowOnce) {
      slowOnce = false;
      await this.db.execute(SLOW_SQL);
    }
    return { ok: true };
  }
}
@Module({ imports: [FixtureModule], controllers: [OrdersController] })
class M {}

/**
 * Final review M3: `503 commit_outcome_unknown` không được lưu làm response cuối của Idempotency-Key. Thử lại cùng key
 * phải cho biết kết quả thật: commit đầu đã bền → trả lại đúng kết quả đó (không ghi lần hai); chưa bền → chạy lại.
 */
describe('Idempotency-Key after 503 commit_outcome_unknown (final review M3)', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  let db: Db;

  const post = (key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', key)
      .set('x-test-principal', PRINCIPAL)
      .send({});
  const rows = async (key: string) =>
    db.execute<{ id: string }>(
      'SELECT id::text AS id FROM fixture_children WHERE email = ?',
      [`${key}@idem.test`],
    );

  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_PORT', String(proxy.port));
    vi.stubEnv('DB_QUERY_TIMEOUT_MS', String(QUERY_TIMEOUT_MS));
    vi.stubEnv('DB_CONNECTION_TIMEOUT_MS', String(CONNECTION_TIMEOUT_MS));
    vi.stubEnv('HTTP_REQUEST_BUDGET_MS', String(REQUEST_BUDGET_MS));
    app = await createTestApp(
      [
        RedisModule,
        HttpModule,
        TestPrincipalModule,
        DatabaseModule.forRoot({ relay: false }),
        M,
      ],
      { beforeInit: applyHttpDefaults },
    );
    db = app.get(Db);
    parentId = await app
      .get(UnitOfWork)
      .run(() => app.get(FixtureRepo).insertParent());
  });
  afterAll(async () => {
    await proxy?.close();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('the commit landed: a retry with the same key re-runs the handler, which returns the original order; no second write', async () => {
    const key = `landed-${randomUUID()}`;
    const before = calls;
    proxy.state.commit = 'pooler-crash';
    const first = await post(key);
    proxy.state.commit = 'pass';
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('commit_outcome_unknown');
    const landed = await rows(key);
    expect(landed).toHaveLength(1);

    const retry = await post(key).expect(201);
    expect(retry.body).toEqual({ id: landed[0]?.id });
    // Lần sau nữa: response thành công đã được lưu, handler không chạy lại.
    const replay = await post(key).expect(201);
    expect(replay.body).toEqual(retry.body);
    expect(calls - before).toBe(2);
    expect(await rows(key)).toHaveLength(1);
  });

  it('the commit never reached the server: a retry with the same key executes the request once', async () => {
    const key = `dropped-${randomUUID()}`;
    const before = calls;
    proxy.state.commit = 'blackhole';
    const first = await post(key);
    proxy.state.commit = 'pass';
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('commit_outcome_unknown');
    // Kysely 0.29.6 không trả connection khi COMMIT/ROLLBACK lỗi: bộ thu hồi của api trả nó ở HTTP_REQUEST_BUDGET_MS
    // (huỷ socket → PgBouncer đóng connection server → Postgres rollback). Trước đó lần thử lại chờ lock của transaction
    // cũ và nhận 503 service_unavailable — ca đó có test riêng bên dưới.
    await vi.waitFor(() => expect(app.get(CorePools).checkedOut()).toBe(0), {
      timeout: REQUEST_BUDGET_MS + LATENCY_MARGIN_MS,
    });
    expect(await rows(key)).toHaveLength(0);

    const retry = await post(key).expect(201);
    const written = await rows(key);
    expect(written).toHaveLength(1);
    expect(retry.body).toEqual({ id: written[0]?.id });
    expect(calls - before).toBe(2);
  });

  it('a transient DB failure (503 service_unavailable) is not stored either: the same key executes again', async () => {
    const key = `flaky-${randomUUID()}`;
    const before = calls;
    slowOnce = true;
    const first = await request(app.getHttpServer())
      .post('/api/v1/orders/flaky')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', key)
      .set('x-test-principal', PRINCIPAL)
      .send({});
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('service_unavailable');
    const retry = await request(app.getHttpServer())
      .post('/api/v1/orders/flaky')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', key)
      .set('x-test-principal', PRINCIPAL)
      .send({})
      .expect(201);
    expect(retry.body).toEqual({ ok: true });
    expect(calls - before).toBe(2);
  });
});
