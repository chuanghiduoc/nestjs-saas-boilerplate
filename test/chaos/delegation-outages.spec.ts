import {
  Controller,
  Get,
  Global,
  Logger,
  Module,
  Param,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthFacts,
  PlatformAccessAudit,
  PlatformRoleChangeListener,
  PlatformStaffAction,
} from '../../src/modules/identity/index.js';
import {
  LOGIN_LOCKOUT,
  type LoginLockout,
} from '../../src/modules/identity/infra/better-auth/login-lockout.js';
import { StaffStepUp } from '../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { PermissionCatalogueRegistry } from '../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { SupportGrantRepository } from '../../src/modules/tenancy/ports/support-grant-repository.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { enrolStaff, marksOf, stepUp } from '../support/staff.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { authed, startTenancyApp } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';

/** Hạn của một request khi DB blackhole: query timeout của pool (mặc định) cộng biên; quá mức này là treo. */
const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };

let auditCalls = 0;
class CountingAudit extends PlatformAccessAudit {
  record(): Promise<void> {
    auditCalls += 1;
    return Promise.resolve();
  }
}
@Global()
@Module({
  providers: [{ provide: PlatformAccessAudit, useClass: CountingAudit }],
  exports: [PlatformAccessAudit],
})
class CountingAuditModule {}
let handlerCalls = 0;
@Controller('v1/admin/__fixture')
class FixtureAdminController {
  @PlatformStaffAction()
  @Get(':itemId')
  get(this: void, @Param('itemId') itemId: string) {
    handlerCalls += 1;
    return { itemId };
  }
}
@Module({ controllers: [FixtureAdminController] })
class FixtureAdminModule {}

const isEvent = (o: unknown, event: string): boolean =>
  typeof o === 'object' &&
  o !== null &&
  'event' in o &&
  (o as { event: unknown }).event === event;

/**
 * Spec SP3 tiêu chí 12 (phần 3D), PSA-4/C11: mỗi câu mới của 3D gặp DB mất (blackhole, không RST) → `503`, không bao giờ
 * `401`/`403`/`404` hay treo. Pool app (qua PgBouncer) và pool `auth_user` (thẳng Postgres) đi qua hai proxy riêng. Ca nào
 * nhắm một câu cụ thể thì bật blackhole BÊN TRONG phương thức thật (spy bọc nó): cắt từ trước request thì câu tra session
 * (pool auth) hay câu tra membership (pool app) đã trả `503` trước khi tới câu cần thử.
 */
describe('DB outages on the delegation paths (spec SP3 tiêu chí 12, phần 3D; PSA-4)', () => {
  let app: INestApplication;
  let appDb: TcpProxy;
  let authDb: TcpProxy;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const enrolled: string[] = [];
  const orgs: SeededOrg[] = [];
  const http = () => request(app.getHttpServer());
  /** Bật blackhole trong lúc `fn` chạy (câu thật của phương thức bị bọc), tắt khi nó xong hoặc ném. */
  const blackholed = async <T>(proxy: TcpProxy, fn: () => Promise<T>) => {
    proxy.state.blackhole = true;
    try {
      return await fn();
    } finally {
      proxy.state.blackhole = false;
    }
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const r = await fn();
    expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
    return r;
  };
  const ownerOrg = async () => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    return org;
  };
  /** Owner + org + một ADMIN tạo key `org.read`. */
  const keyCast = async () => {
    const org = await ownerOrg();
    const creator = await seedUserPrincipal();
    principals.push(creator);
    const m = await seedMember(org, 'ADMIN', {
      authUserId: creator.authUserId,
    });
    const key = await seedOrgApiKey(org, {
      createdByMemberId: m.memberId,
      permissions: ['org.read'],
    });
    return { org, key };
  };
  /** Owner + org + nhân viên đã step-up + grant preset do owner cấp. */
  const grantCast = async () => {
    const org = await ownerOrg();
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const grant = await seedSupportGrant(org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
    });
    return { org, staff, grant };
  };
  /** FORCE RLS: đọc bảng tenant bằng app_user trong OrgScope (ownerQuery không có org context thì thấy 0 dòng). */
  const grantRow = async (org: SeededOrg, grantId: string) =>
    (
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query<{ first_used_at: Date | null; revoked_at: Date | null }>(
            'SELECT first_used_at, revoked_at FROM org_support_grants WHERE id = $1',
            [grantId],
          ),
        ),
      )
    ).rows;
  const eventsOf = (type: string, aggregateId: string) =>
    ownerQuery(
      'SELECT 1 FROM outbox_events WHERE type = $1 AND aggregate_id = $2',
      [type, aggregateId],
    );

  beforeAll(async () => {
    const { pg: p, pgbouncer } = getInfra();
    appDb = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    authDb = await startTcpProxy(p.host, p.port);
    app = await startTenancyApp({
      env: {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(appDb.port),
        DB_AUTH_HOST: '127.0.0.1',
        DB_AUTH_PORT: String(authDb.port),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
      extraImports: [CountingAuditModule, FixtureAdminModule],
    });
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    appDb.state.blackhole = false;
    authDb.state.blackhole = false;
    for (const o of orgs) await o.dispose();
    await app?.close();
    await appDb?.close();
    await authDb?.close();
    await deleteSeededPrincipals(principals);
    for (const id of enrolled) {
      await ownerQuery('DELETE FROM tenancy_users WHERE auth_user_id = $1', [
        id,
      ]);
      await ownerQuery('DELETE FROM auth."user" WHERE id = $1', [id]);
    }
    vi.unstubAllEnvs();
  });

  it('org key authentication with the app DB blackholed (key lookup) → 503 + Retry-After, never 401; works again after recovery', async () => {
    const { org, key } = await keyCast();
    const get = () =>
      http().get(`/v1/orgs/${org.orgId}`).set('x-api-key', key.token);
    const r = await timed(() => blackholed(appDb, get));
    expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    expect(r.headers['retry-after']).toBeDefined();
    await vi.waitFor(
      async () => expect((await get()).status).toBe(200),
      RECOVERY,
    );
  });
  it('org key authentication with the auth DB blackholed (creator lookup) → 503, never 401; works again after recovery', async () => {
    const { org, key } = await keyCast();
    const get = () =>
      http().get(`/v1/orgs/${org.orgId}`).set('x-api-key', key.token);
    const r = await timed(() => blackholed(authDb, get));
    expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    await vi.waitFor(
      async () => expect((await get()).status).toBe(200),
      RECOVERY,
    );
  });
  it('support branch: the auth DB blackholed exactly at the mark read (secondFactorVerifiedAt) → 503 + Retry-After, not 403 and not 404', async () => {
    const g = await grantCast();
    const facts = app.get(AuthFacts);
    const realRead = facts.secondFactorVerifiedAt.bind(facts);
    const spy = vi
      .spyOn(facts, 'secondFactorVerifiedAt')
      .mockImplementationOnce(() => blackholed(authDb, realRead));
    try {
      const r = await timed(() =>
        authed(app, g.staff).get(`/v1/orgs/${g.org.orgId}`),
      );
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(r.headers['retry-after']).toBeDefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await grantRow(g.org, g.grant.id)).toEqual([
      { first_used_at: null, revoked_at: null },
    ]);
  });
  it('support first use: the write transaction on a blackholed app DB → 503; the grant stays unused and no used event; the retry marks it once', async () => {
    const g = await grantCast();
    const repo = app.get(SupportGrantRepository);
    const realMark = repo.markFirstUse.bind(repo);
    const spy = vi
      .spyOn(repo, 'markFirstUse')
      .mockImplementationOnce((id) => blackholed(appDb, () => realMark(id)));
    try {
      const r = await timed(() =>
        authed(app, g.staff).get(`/v1/orgs/${g.org.orgId}`),
      );
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await grantRow(g.org, g.grant.id)).toEqual([
      { first_used_at: null, revoked_at: null },
    ]);
    expect(
      await eventsOf('tenancy.support_access.used', g.grant.publicId),
    ).toHaveLength(0);
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, g.staff).get(`/v1/orgs/${g.org.orgId}`)).status,
        ).toBe(200),
      RECOVERY,
    );
    const [row] = await grantRow(g.org, g.grant.id);
    expect(row?.first_used_at).toBeInstanceOf(Date);
    expect(
      await eventsOf('tenancy.support_access.used', g.grant.publicId),
    ).toHaveLength(1);
  });
  it('S-20: the step-up lockout storage down (auth DB blackholed inside guard) → 503, no mark; the same step-up after recovery → 200 + one mark', async () => {
    const s = await enrolStaff(app);
    enrolled.push(s.userId);
    const lockout = app.get<LoginLockout>(LOGIN_LOCKOUT);
    const realGuard = lockout.guard.bind(lockout);
    const spy = vi
      .spyOn(lockout, 'guard')
      .mockImplementationOnce((scope) =>
        blackholed(authDb, () => realGuard(scope)),
      );
    try {
      const r = await timed(() => stepUp(s));
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(spy.mock.calls.map(([scope]) => scope.kind)).toEqual(['step-up']);
    } finally {
      spy.mockRestore();
    }
    expect(await marksOf(s.userId)).toEqual([]);
    await vi.waitFor(
      async () => expect((await stepUp(s)).status).toBe(200),
      RECOVERY,
    );
    expect(await marksOf(s.userId)).toHaveLength(1);
  });
  it('PSA-4 / C11: the TOTP-mark query of PlatformStaffGuard on a blackholed auth DB → 503 + Retry-After; the handler and the audit port do not run', async () => {
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const stepUpPort = app.get(StaffStepUp);
    const realFresh = stepUpPort.totpMarkFresh.bind(stepUpPort);
    const spy = vi
      .spyOn(stepUpPort, 'totpMarkFresh')
      .mockImplementationOnce((...a) =>
        blackholed(authDb, () => realFresh(...a)),
      );
    const [audits, handlers] = [auditCalls, handlerCalls];
    const get = () =>
      http()
        .get('/v1/admin/__fixture/1')
        .set('authorization', `Bearer ${staff.bearer}`);
    try {
      const r = await timed(get);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(r.headers['retry-after']).toBeDefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect([auditCalls, handlerCalls]).toEqual([audits, handlers]);
    await vi.waitFor(
      async () => expect((await get()).status).toBe(200),
      RECOVERY,
    );
    expect([auditCalls, handlerCalls]).toEqual([audits + 1, handlers + 1]);
  });
  it('S-23: revoking grants on a role write with the app DB blackholed → 503 + ERROR platform_role_change_listener_failed; the retry revokes', async () => {
    const g = await grantCast();
    const admin = await enrolStaff(app);
    enrolled.push(admin.userId);
    expect((await stepUp(admin)).status).toBe(200);
    const listener = app.get(PlatformRoleChangeListener);
    const realChange = listener.onPlatformRoleChanged.bind(listener);
    const spy = vi
      .spyOn(listener, 'onPlatformRoleChanged')
      .mockImplementationOnce((id) => blackholed(appDb, () => realChange(id)));
    const errors = vi.spyOn(Logger.prototype, 'error');
    const setRole = () =>
      admin.client.request('post', '/api/auth/admin/set-role', {
        body: { userId: g.staff.authUserId, role: 'user' },
      });
    try {
      const r = await timed(setRole);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        errors.mock.calls.some(([o]) =>
          isEvent(o, 'platform_role_change_listener_failed'),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    expect((await grantRow(g.org, g.grant.id))[0]?.revoked_at).toBeNull();
    await vi.waitFor(
      async () => expect((await setRole()).status).toBe(200),
      RECOVERY,
    );
    expect((await grantRow(g.org, g.grant.id))[0]?.revoked_at).toBeInstanceOf(
      Date,
    );
  });
});
