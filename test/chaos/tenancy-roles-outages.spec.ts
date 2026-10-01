import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/core/database/index.js';
import { PermissionCatalogueRegistry } from '../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { SqlRoleRepository } from '../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { TenancyTestHooks } from '../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { installOtelCapture } from '../support/otel-capture.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { authed, startTenancyApp } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  roleSetC1,
  seedCustomRole,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
} from '../support/tenancy-seed.js';

const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };
/** Một lần mỗi file, trước khi app tạo meter. */
const otel = installOtelCapture();
const UNAVAILABLE = { via: 'MEMBERSHIP', result: 'unavailable' };

/**
 * Bật blackhole đúng lúc câu thứ hai của đường nóng (spec §7.3) bắt đầu: câu tra membership (câu thứ nhất) đã chạy xong
 * qua proxy, nên lỗi hạ tầng chỉ đến từ câu mới của 3B.
 */
class BlackholeOnPermissionKeys extends SqlRoleRepository {
  armed: TcpProxy | undefined;
  override permissionKeys(
    roleIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.permissionKeys(roleIds);
  }
}

/** Bật blackhole đúng một lần ở `afterGuard` (sau `PoliciesGuard`, trước transaction của `RoleService`). */
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

describe('app DB lost during custom role work (spec SP3 tiêu chí 12, phần 3B)', () => {
  const hooks = new BlackholeAfterGuard();
  let secondStatement: BlackholeOnPermissionKeys | undefined;
  let proxy: TcpProxy;
  let app: INestApplication;
  let owner: SeededPrincipal;
  let holder: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    // Chỉ pool `app` qua proxy; pool `auth_user` đi thẳng PgBouncer nên xác thực vẫn chạy. `RoleRepository` là
    // `useExisting: SqlRoleRepository` (3A), nên thay `SqlRoleRepository` là thay repository của mọi chỗ gọi.
    app = await startTenancyApp({
      env: {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(proxy.port),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
      configure: (b) =>
        b
          .overrideProvider(TenancyTestHooks)
          .useValue(hooks)
          .overrideProvider(SqlRoleRepository)
          .useFactory({
            factory: (db: Db) =>
              (secondStatement = new BlackholeOnPermissionKeys(db)),
            inject: [Db],
          }),
    });
    owner = await seedUserPrincipal();
    holder = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const c1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
    await seedMemberInRole(
      org,
      await seedCustomRole(org, { permissions: c1 }),
      { authUserId: holder.authUserId },
    );
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([owner, holder]);
    vi.unstubAllEnvs();
  });

  it('POST roles: DB lost after the guard → 503 within the bound; no role, no tenancy.role.created', async () => {
    const name = `Outage ${v7()}`;
    hooks.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, owner)
        .post(`/v1/orgs/${org.orgId}/roles`)
        .set('idempotency-key', `k-${v7()}`)
        .send({ name, permissions: ['org.read'] });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      hooks.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, owner).get(`/v1/orgs/${org.orgId}/roles`)).status,
        ).toBe(200),
      RECOVERY,
    );
    const roles = (await authed(app, owner).get(`/v1/orgs/${org.orgId}/roles`))
      .body.data as { name: string | null }[];
    expect(roles.map((x) => x.name)).not.toContain(name);
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.role.created'`,
        [org.orgId],
      ),
    ).toEqual([]);
  });
  it('a custom-role holder: DB lost exactly at the second hot-path statement → 503 + Retry-After from the guarded lookup (tiêu chí 12 for the 3B query)', async () => {
    const repo = secondStatement;
    if (!repo) throw new Error('the SqlRoleRepository override was not built');
    const unavailableBefore =
      (await otel.metric('tenancy_org_access_total', UNAVAILABLE)) ?? 0;
    repo.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, holder).get(`/v1/orgs/${org.orgId}/members`);
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Seam đã chạy: câu membership (câu thứ nhất) xong rồi mới tới `permissionKeys`, nơi blackhole bật.
      expect(repo.armed).toBeUndefined();
      // Nhánh `unavailable` của `lookup()` (không phải filter toàn cục) đã xử lý: câu thứ hai nằm trong try/catch của nó.
      expect(await otel.metric('tenancy_org_access_total', UNAVAILABLE)).toBe(
        unavailableBefore + 1,
      );
    } finally {
      repo.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, holder).get(`/v1/orgs/${org.orgId}/members`))
            .status,
        ).toBe(200),
      RECOVERY,
    );
  });
});
