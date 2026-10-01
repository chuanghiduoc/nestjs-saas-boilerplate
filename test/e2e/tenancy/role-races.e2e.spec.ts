import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import {
  ROLE_SET_C0,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import { prng } from '../../unit/modules/tenancy/prng.js';

const ROUNDS = 20;
const X5_OPS = 20;
const INSERT_BUDGET_MS = 1000;

describe('role races under the org lock (spec SP3 §17 T-8, T-9, T-24; §18.3 X-1, X-2, X-3, X-5)', () => {
  let app: INestApplication;
  /** C1 = MEMBER ∪ {members.role.assign} của catalogue gộp thật (R-X24): ở X-2, Y = C1 ∪ {members.remove} phải trội MEMBER để chỉ luật 2 quyết định. */
  let C1: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const newOrg = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    return { O, org };
  };
  const assign = (
    as: SeededPrincipal,
    org: SeededOrg,
    memberId: string,
    roleId: string,
  ) =>
    authed(app, as)
      .patch(`/v1/orgs/${org.orgId}/members/${memberId}`)
      .set('if-match', '*')
      .send({ roleId });
  const outboxId = async (type: string, aggregateId: string) =>
    BigInt(
      (
        await ownerQuery<{ id: string }>(
          `SELECT id::text FROM outbox_events WHERE type = $1 AND aggregate_id = $2 ORDER BY id DESC LIMIT 1`,
          [type, aggregateId],
        )
      )[0]?.id ?? '0',
    );
  /** Không role tuỳ biến nào của org thiếu quyền mà nó `requires` (đọc bằng app_user trong OrgScope). */
  const openSets = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(
        c,
        orgId,
        async () =>
          (
            await c.query<{
              n: number;
            }>(`SELECT count(*)::int AS n FROM org_role_permissions s JOIN permission_requires r ON r.permission_id = s.permission_id
          WHERE NOT EXISTS (SELECT 1 FROM org_role_permissions t WHERE t.org_id = s.org_id AND t.role_id = s.role_id AND t.permission_id = r.required_permission_id)`)
          ).rows[0]?.n,
      ),
    );
  const owners = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, async () =>
        Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`,
            )
          ).rows[0]?.n,
        ),
      ),
    );
  beforeAll(async () => {
    app = await startTenancyApp({ env: { THROTTLE_DEFAULT_LIMIT: '100000' } });
    C1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`X-1 ×${ROUNDS}: the owner demotes A2 while A2 assigns C1 → A2's assignment never commits after it lost members.role.assign`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const A2 = await seedP();
      const a2 = await seedMember(org, 'ADMIN', { authUserId: A2.authUserId });
      const m = await seedMember(org, 'MEMBER', {
        authUserId: (await seedP()).authUserId,
      });
      const [demote, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          assign(O, org, a2.memberPublicId, org.roles.MEMBER.publicId),
          assign(A2, org, m.memberPublicId, c1.publicId),
        ]),
      );
      expect(demote.status).toBe(200);
      expect([200, 403]).toContain(give.status);
      if (give.status === 200)
        expect(
          await outboxId('tenancy.member.role_changed', m.memberPublicId),
        ).toBeLessThan(
          await outboxId('tenancy.member.role_changed', a2.memberPublicId),
        );
    }
  }, 180_000);
  it(`X-2 / T-8 ×${ROUNDS}: the owner adds a key to C1 that the assigner lacks while it assigns C1 → never both on the widened set`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const y = await seedCustomRole(org, {
        permissions: [...C1, 'members.remove'],
      });
      const Y = await seedP();
      await seedMemberInRole(org, y, { authUserId: Y.authUserId });
      const m = await seedMember(org, 'MEMBER', {
        authUserId: (await seedP()).authUserId,
      });
      const [edit, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, O)
            .patch(`/v1/orgs/${org.orgId}/roles/${c1.publicId}`)
            .set('if-match', '*')
            .send({ permissions: [...C1, 'invitations.read'] }),
          assign(Y, org, m.memberPublicId, c1.publicId),
        ]),
      );
      expect(edit.status).toBe(200);
      expect([give.status, give.body.code]).toEqual(
        give.status === 200 ? [200, undefined] : [403, 'escalation_denied'],
      );
      if (give.status === 200)
        expect(
          await outboxId('tenancy.member.role_changed', m.memberPublicId),
        ).toBeLessThan(await outboxId('tenancy.role.updated', c1.publicId));
    }
  }, 180_000);
  it(`X-3 / T-9 ×${ROUNDS}: deleting C1 while assigning it → one side fails with a code, never an orphan`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const m = await seedMember(org, 'MEMBER', {
        authUserId: (await seedP()).authUserId,
      });
      const [del, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, O).delete(`/v1/orgs/${org.orgId}/roles/${c1.publicId}`),
          assign(O, org, m.memberPublicId, c1.publicId),
        ]),
      );
      const outcome = [
        del.status,
        give.status,
        give.body.code ?? del.body.code,
      ];
      expect([
        [204, 422, 'validation_failed'],
        [409, 200, 'role_in_use'],
      ]).toContainEqual(outcome);
    }
  }, 180_000);
  it('R3B-2: two creates with the same name at once → one 201, one 409 role_name_taken', async () => {
    const { O, org } = await newOrg();
    const name = `Twin ${v7()}`;
    const post = () =>
      authed(app, O)
        .post(`/v1/orgs/${org.orgId}/roles`)
        .set('idempotency-key', `k-${v7()}`)
        .send({ name, permissions: ROLE_SET_C0 });
    const rs = await raceOnOrgLock(org.orgId, 2, () =>
      Promise.all([post(), post()]),
    );
    expect(rs.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)?.body.code).toBe('role_name_taken');
  });
  it('R3B-3: two PATCHes with the same ETag → one 200, one 412', async () => {
    const { O, org } = await newOrg();
    const c0 = await seedCustomRole(org, { permissions: ROLE_SET_C0 });
    const put = (name: string) =>
      authed(app, O)
        .patch(`/v1/orgs/${org.orgId}/roles/${c0.publicId}`)
        .set('if-match', '"1"')
        .send({ name });
    const rs = await raceOnOrgLock(org.orgId, 2, () =>
      Promise.all([put('First'), put('Second')]),
    );
    expect(rs.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 412]);
  });
  it(`X-5 / T-24 with custom roles: ${X5_OPS} random role edits and assignments at once — no deadlock, no 5xx, ≥ 1 owner, every set closed, feature INSERTs not blocked`, async () => {
    const { O, org } = await newOrg();
    const O2 = await seedP();
    const o2 = await seedMember(org, 'OWNER', { authUserId: O2.authUserId });
    const c0 = await seedCustomRole(org, { permissions: ROLE_SET_C0 });
    const c1 = await seedCustomRole(org, { permissions: C1 });
    // O2 cũng là đích: hai owner hạ nhau cùng lúc chạm trigger owner cuối (T-1) trong cùng mớ khoá với role tuỳ biến.
    const targets = [o2];
    for (let i = 0; i < 3; i++)
      targets.push(
        await seedMember(org, 'MEMBER', {
          authUserId: (await seedP()).authUserId,
        }),
      );
    const rnd = prng(20260929);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rnd() * xs.length)] as T;
    const ops = Array.from({ length: X5_OPS }, () =>
      rnd() < 0.5
        ? assign(
            pick([O, O2]),
            org,
            pick(targets).memberPublicId,
            pick([org.roles.ADMIN, org.roles.MEMBER, c0, c1]).publicId,
          )
        : authed(app, pick([O, O2]))
            .patch(`/v1/orgs/${org.orgId}/roles/${pick([c0, c1]).publicId}`)
            .set('if-match', '*')
            .send({
              permissions: pick([
                [...C1],
                [...C1, 'invitations.read'],
                ['org.read', 'roles.read', 'invitations.read'],
                [...ROLE_SET_C0],
              ]),
            }),
    );
    const inserts = Array.from({ length: 5 }, () =>
      withAppClient((c) =>
        inOrgTx(c, org.orgId, async () => {
          const started = performance.now();
          await c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [
            org.orgId,
          ]);
          return performance.now() - started;
        }),
      ),
    );
    const [responses, latencies] = await Promise.all([
      Promise.all(ops),
      Promise.all(inserts),
    ]);
    expect(responses.filter((r) => r.status >= 500).map((r) => r.body)).toEqual(
      [],
    );
    expect(Math.max(...latencies)).toBeLessThan(INSERT_BUDGET_MS);
    expect(await owners(org.orgId)).toBeGreaterThanOrEqual(1);
    expect(await openSets(org.orgId)).toBe(0);
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId]),
      ),
    );
  }, 120_000);
});
