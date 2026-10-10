import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OrgScope,
  UnitOfWork,
  isDbInfraError,
} from '../../src/core/database/index.js';
import { toAppError } from '../../src/core/errors/index.js';
import {
  PlanAssignments,
  Quotas,
} from '../../src/modules/entitlements/index.js';
import { SqlOrgEntitlementRepository } from '../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { SqlOverrideRepository } from '../../src/modules/entitlements/infra/sql/sql-override.repository.js';
import { SqlUsageCounterRepository } from '../../src/modules/entitlements/infra/sql/sql-usage-counter.repository.js';
import { startEntitlementsApp } from '../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../support/entitlements-fixtures.js';
import {
  outboxOf,
  readCounters,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
} from '../support/entitlements-seed.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { joinInviteLink } from '../support/tenancy-acquisition.js';
import { authed } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  seedInviteLink,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

/** Cận trên của một request trong blackhole: chờ connection + query quá hạn + ROLLBACK quá hạn (mặc định của app) + dư. */
const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };

/**
 * Tiêu chí 11 / F-1 (spec SP4): chỉ pool `app` đi qua proxy; blackhole bật đúng lúc câu của entitlements sắp chạy (bọc phương
 * thức repository thật), nên lỗi rơi vào câu snapshot / câu khoá của `assign`, không vào tra membership của middleware.
 */
describe('the database lost under entitlement reads and assignments answers 503, never 500', () => {
  let proxy: TcpProxy;
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  /**
   * Spy trên CHÍNH instance repository của app (`OrgEntitlementRepository` là `useExisting` của nó), bản gốc giữ bằng `bind`.
   * Bật blackhole ngay trước câu snapshot thật (một lần).
   */
  const armSnapshot = () => {
    const repo = app.get(SqlOrgEntitlementRepository);
    const original = repo.readSnapshot.bind(repo);
    vi.spyOn(repo, 'readSnapshot').mockImplementationOnce(() => {
      proxy.state.blackhole = true;
      return original();
    });
  };
  /** Bật blackhole ngay trước câu khoá thật của `assign` (một lần). */
  const armAssignLock = () => {
    const repo = app.get(SqlOrgEntitlementRepository);
    const original = repo.lockForAssignment.bind(repo);
    vi.spyOn(repo, 'lockForAssignment').mockImplementationOnce(
      (key: string) => {
        proxy.state.blackhole = true;
        return original(key);
      },
    );
  };
  /** Bật blackhole ngay trước câu consume thật (một lần): lỗi rơi vào câu INSERT … ON CONFLICT, không vào câu snapshot. */
  const armConsume = () => {
    const repo = app.get(SqlUsageCounterRepository);
    const original = repo.consume.bind(repo);
    vi.spyOn(repo, 'consume').mockImplementationOnce((i) => {
      proxy.state.blackhole = true;
      return original(i);
    });
  };
  /** Bật blackhole ngay trước câu upsert override thật (một lần): khoá dòng gốc đã lấy, lỗi rơi vào câu ghi. */
  const armOverrideUpsert = () => {
    const repo = app.get(SqlOverrideRepository);
    const original = repo.upsert.bind(repo);
    vi.spyOn(repo, 'upsert').mockImplementationOnce((o) => {
      proxy.state.blackhole = true;
      return original(o);
    });
  };
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule],
      env: {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(proxy.port),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(org.orgId, 'metered');
  });
  afterAll(async () => {
    if (proxy) proxy.state.blackhole = false;
    vi.restoreAllMocks();
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    if (owner) await deleteSeededPrincipals([owner]);
    await disposeCatalogue?.();
    vi.unstubAllEnvs();
  });

  it('GET …/entitlements: DB lost at the snapshot query → 503 service_unavailable within the bound; recovers to 200', async () => {
    armSnapshot();
    try {
      const started = performance.now();
      const r = await authed(app, owner).get(
        `/v1/orgs/${org.orgId}/entitlements`,
      );
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (await authed(app, owner).get(`/v1/orgs/${org.orgId}/entitlements`))
            .status,
        ).toBe(200),
      RECOVERY,
    );
  });
  it('assign: DB lost at the locking read → an infra error mapped to 503; nothing written, no event', async () => {
    armAssignLock();
    let err: unknown;
    try {
      err = await app
        .get(OrgScope)
        .run(org.orgId, () =>
          app.get(UnitOfWork).run(() =>
            app.get(PlanAssignments).assign({
              planKey: 'pro',
              cause: { kind: 'BILLING', ref: 'sub_1', sequence: 1n },
            }),
          ),
        )
        .catch((e: unknown) => e);
    } finally {
      proxy.state.blackhole = false;
    }
    expect(isDbInfraError(err)).toBe(true);
    expect(toAppError(err).error.status).toBe(503);
    await vi.waitFor(
      async () =>
        expect(await readOrgEntitlement(org.orgId)).toMatchObject({
          planKey: 'metered',
          version: 1,
          lastBillingSeq: null,
        }),
      RECOVERY,
    );
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed'`,
        [org.orgId],
      ),
    ).toEqual([]);
  });
  it('consume: DB lost at the consume statement → an infra error mapped to 503; no counter, no event', async () => {
    armConsume();
    let err: unknown;
    try {
      err = await app
        .get(OrgScope)
        .run(org.orgId, () =>
          app
            .get(UnitOfWork)
            .run(() => app.get(Quotas).consume('fixture.api_calls', 1)),
        )
        .catch((e: unknown) => e);
    } finally {
      proxy.state.blackhole = false;
    }
    expect(isDbInfraError(err)).toBe(true);
    expect(toAppError(err).error.status).toBe(503);
    await vi.waitFor(
      async () => expect(await readCounters(org.orgId)).toEqual([]),
      RECOVERY,
    );
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.quota.reached'`,
        [org.orgId],
      ),
    ).toEqual([]);
  });
  it('join: DB lost at the seat read (the snapshot inside MemberAdmission) → 503; no member, the link use rolls back', async () => {
    const joiner = await seedUserPrincipal();
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 5,
    });
    try {
      armSnapshot();
      let status: number;
      try {
        const started = performance.now();
        const r = await joinInviteLink(app, joiner, { token: link.token });
        expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
        status = r.status;
      } finally {
        proxy.state.blackhole = false;
      }
      expect(status).toBe(503);
      await vi.waitFor(
        async () =>
          expect(
            (
              await withAppClient((c) =>
                inOrgTx(c, org.orgId, () =>
                  c.query(
                    'SELECT (SELECT count(*)::int FROM org_members) AS members, (SELECT use_count FROM org_invite_links WHERE id = $1) AS uses',
                    [link.id],
                  ),
                ),
              )
            ).rows,
          ).toEqual([{ members: 1, uses: 0 }]),
        RECOVERY,
      );
    } finally {
      await deleteSeededPrincipals([joiner]);
    }
  });
  it('admin override: DB lost at the upsert → 503 within the bound; no override, no version change, no event; the retry succeeds', async () => {
    const staff = await seedStaffPrincipal();
    const target = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(target.orgId, 'metered');
    const put = () =>
      request(app.getHttpServer())
        .put(
          `/v1/admin/orgs/${target.orgId}/entitlements/overrides/tenancy.seats`,
        )
        .set('authorization', `Bearer ${staff.bearer}`)
        .set('if-match', 'W/"1"')
        .send({ limit: 1, reason: 'chaos', expiresAt: null });
    try {
      armOverrideUpsert();
      let status: number;
      try {
        const started = performance.now();
        const r = await put();
        expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
        status = r.status;
      } finally {
        proxy.state.blackhole = false;
      }
      expect(status).toBe(503);
      await vi.waitFor(
        async () => expect(await readOverrides(target.orgId)).toEqual([]),
        RECOVERY,
      );
      expect((await readOrgEntitlement(target.orgId))?.version).toBe(1);
      expect(await outboxOf(target.orgId, 'entitlements.override.set')).toEqual(
        [],
      );
      await vi.waitFor(
        async () => expect((await put()).status).toBe(200),
        RECOVERY,
      );
    } finally {
      await target.dispose();
      await deleteSeededPrincipals([staff]);
    }
  });
});
