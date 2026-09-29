import type { INestApplication } from '@nestjs/common';
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
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenancyTestHooks } from '../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { readImages } from '../support/images.js';
import { authed, startTenancyApp } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

/** Tham số của bộ test (không phải config của app). */
const MISS_LIMIT = 3;
/** Cận trên của một request trong blackhole: chờ connection + query quá hạn + ROLLBACK quá hạn (mặc định của app) + dư. */
const OUTAGE_BOUND_MS = 20_000;
const REDIS_PORT = 6379;
const RECOVERY = { timeout: 30_000, interval: 250 };

/**
 * Seam `afterGuard` (Task 19; gọi sau `PoliciesGuard`, trước transaction của mutation quản trị): bật blackhole đúng một
 * lần, để lỗi DB rơi vào transaction của mutation chứ không vào câu tra membership của middleware (tiêu chí 12, review M5).
 */
class BlackholeAfterGuard extends TenancyTestHooks {
  armed: TcpProxy | undefined;
  afterGuard(): Promise<void> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return Promise.resolve();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}

describe('app DB blackholed during the membership lookup (spec SP3 §7.1 bước 3.11, tiêu chí 12, SEC2-N6)', () => {
  const hooks = new BlackholeAfterGuard();
  let proxy: TcpProxy;
  let app: INestApplication;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  const orgName = () =>
    withAppClient((c) =>
      inOrgTx(
        c,
        org.orgId,
        async () =>
          (
            await c.query<{ name: string }>(
              'SELECT name FROM organizations WHERE id = $1',
              [org.orgId],
            )
          ).rows[0]?.name,
      ),
    );
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    // Chỉ pool `app` đi qua proxy; pool `auth_user` (DB_AUTH_HOST) đi thẳng PgBouncer nên xác thực vẫn chạy.
    app = await startTenancyApp({
      env: {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(proxy.port),
        TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
      configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks),
    });
    member = await seedUserPrincipal();
    outsider = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: member.authUserId } });
  });
  afterAll(async () => {
    if (proxy) proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([member, outsider]);
    vi.unstubAllEnvs();
  });

  it('member and non-member both get 503 + Retry-After within the bound; the miss limiter is not charged', async () => {
    proxy.state.blackhole = true;
    const started = performance.now();
    const [m, o] = await Promise.all([
      authed(app, member).get(`/v1/orgs/${org.orgId}`),
      authed(app, outsider).get(`/v1/orgs/${org.orgId}`),
    ]);
    expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
    for (const r of [m, o]) {
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    proxy.state.blackhole = false;
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
        ).toBe(200),
      RECOVERY,
    );
    // Lần 503 lúc sập không bị đếm: vẫn còn đủ MISS_LIMIT + 1 lần 404 (hợp đồng peek của Task 5) trước khi 429.
    for (let i = 0; i < MISS_LIMIT + 1; i++)
      expect(
        (await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status,
        `miss ${i + 1}`,
      ).toBe(404);
    expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status).toBe(
      429,
    );
  });
  it('criterion 12 on a mutation: DB lost after the guard, inside the rename transaction → 503 within the bound; no rename, no event', async () => {
    const before = await orgName();
    hooks.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, member)
        .patch(`/v1/orgs/${org.orgId}`)
        .set('if-match', '*')
        .send({ name: 'Renamed during outage' });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      hooks.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
        ).toBe(200),
      RECOVERY,
    );
    expect(await orgName()).toBe(before);
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.updated'`,
        [org.orgId],
      ),
    ).toEqual([]);
  });
  it('criterion 12 outside an org path: POST /v1/orgs while the DB is blackholed → 503, no org row for the name', async () => {
    const name = `During DB outage ${v7()}`;
    proxy.state.blackhole = true;
    try {
      const r = await authed(app, member)
        .post('/v1/orgs')
        .set('idempotency-key', `k-${v7()}`)
        .send({ name });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
        ).toBe(200),
      RECOVERY,
    );
    // `organizations` là FORCE RLS; đếm qua hàm definer `tenancy_count_user_orgs(bigint, boolean)` (Task 15, không cần
    // OrgScope): member vẫn chỉ thuộc đúng org seed, request lúc sập không tạo org nào.
    const [mine] = await withAppClient(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT tenancy_count_user_orgs((SELECT id FROM tenancy_users WHERE auth_user_id = $1), false)::int AS n`,
            [member.authUserId],
          )
        ).rows,
    );
    expect(mine?.n).toBe(1);
  });
});

describe('Redis down: tenant routes keep working and the miss limiter falls back to the per-pod insurance (CDX-13)', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const images = readImages();
    if (!images.IMAGE_REDIS || !images.IMAGE_TOXIPROXY)
      throw new Error(
        'IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env',
      );
    network = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS)
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(REDIS_PORT)
      .start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY)
      .withNetwork(network)
      .start();
    proxy = await toxi.createProxy({
      name: 'redis',
      upstream: `redis:${REDIS_PORT}`,
    });
    app = await startTenancyApp({
      env: {
        REDIS_URL: `redis://${proxy.host}:${proxy.port}`,
        TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
    member = await seedUserPrincipal();
    outsider = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: member.authUserId } });
  });
  afterAll(async () => {
    await proxy?.setEnabled(true);
    await org?.dispose();
    await app?.close();
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    await deleteSeededPrincipals([member, outsider]);
    vi.unstubAllEnvs();
  });

  it('member reads succeed, misses are still limited per pod, idempotent creates answer 503', async () => {
    if (!app || !proxy) throw new Error('not started');
    await proxy.setEnabled(false);
    expect(
      (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(200);
    // Insurance theo pod dùng cùng `limit`: MISS_LIMIT + 1 lần 404 (lần làm vượt ngưỡng vẫn là 404), rồi 429.
    for (let i = 0; i < MISS_LIMIT + 1; i++)
      expect(
        (await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status,
        `miss ${i + 1}`,
      ).toBe(404);
    expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status).toBe(
      429,
    );
    const create = await request(app.getHttpServer())
      .post('/v1/orgs')
      .set('authorization', `Bearer ${member.bearer}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'During outage' });
    expect(create.status).toBe(503);
    await proxy.setEnabled(true);
  });
});
