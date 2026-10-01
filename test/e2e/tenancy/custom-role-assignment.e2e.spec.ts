import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  ROLE_SET_C2,
  adminKeys,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import {
  PayrollPermissionsModule,
  installPayrollPermission,
  permissionRowCount,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

describe('assigning and managing with custom roles (spec SP3 §8.4 luật 2, 2a, 4; §18.3 B-*, R-8, R-19)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp của app lúc chạy (R-X24); `payroll.read` không thuộc ADMIN (`grantTo.admin = false`). */
  let ADMIN_KEYS: string[];
  let C1: string[];
  let permissionRowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  /** O owner, A admin, M member, K giữ C1, Bob giữ V ≡ ADMIN, Xp giữ X = ADMIN ∪ {payroll.read}; V′ ≡ ADMIN chưa ai giữ. */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const roles = {
      c0: await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'C0' }),
      c1: await seedCustomRole(org, { permissions: C1, name: 'C1' }),
      c2: await seedCustomRole(org, { permissions: ROLE_SET_C2, name: 'C2' }),
      v: await seedCustomRole(org, { permissions: ADMIN_KEYS, name: 'V' }),
      vPrime: await seedCustomRole(org, {
        permissions: ADMIN_KEYS,
        name: 'V prime',
      }),
      x: await seedCustomRole(org, {
        permissions: [...ADMIN_KEYS, 'payroll.read'],
        name: 'X',
      }),
    };
    const person = async (role: SeededRole | 'ADMIN' | 'MEMBER') => {
      const p = await seedP();
      const m =
        typeof role === 'string'
          ? await seedMember(org, role, { authUserId: p.authUserId })
          : await seedMemberInRole(org, role, { authUserId: p.authUserId });
      return { p, memberId: m.memberPublicId };
    };
    return {
      org,
      O,
      roles,
      A: await person('ADMIN'),
      M: await person('MEMBER'),
      K: await person(roles.c1),
      Bob: await person(roles.v),
      X: await person(roles.x),
    };
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
  const remove = (as: SeededPrincipal, org: SeededOrg, memberId: string) =>
    authed(app, as).delete(`/v1/orgs/${org.orgId}/members/${memberId}`);
  const expectCode = async (
    req: PromiseLike<{ status: number; body: { code?: string } }>,
    status: number,
    code?: string,
  ) => {
    const r = await req;
    expect([r.status, r.body.code]).toEqual([status, code]);
  };

  beforeAll(async () => {
    permissionRowsBefore = await permissionRowCount();
    await installPayrollPermission();
    app = await startTenancyApp({ extraImports: [PayrollPermissionsModule] });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    // DB trở lại đúng như trước file (file sau boot không thấy `payroll.read`).
    expect(await permissionRowCount()).toBe(permissionRowsBefore);
  });

  it('B-1: an ADMIN assigns C1 to a member → 200', async () => {
    const c = await cast();
    await expectCode(
      assign(c.A.p, c.org, c.M.memberId, c.roles.c1.publicId),
      200,
      undefined,
    );
  });
  it('B-2: C1 assigns C2 (has a key C1 lacks) → 403 escalation_denied; B-3: C1 assigns ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(
      assign(c.K.p, c.org, c.M.memberId, c.roles.c2.publicId),
      403,
      'escalation_denied',
    );
    await expectCode(
      assign(c.K.p, c.org, c.M.memberId, c.org.roles.ADMIN.publicId),
      403,
      'owner_only',
    );
  });
  it('B-7: C1 changes the role of an ADMIN → 403 owner_only; C1 removing an ADMIN → 403 (C1 lacks members.remove)', async () => {
    const c = await cast();
    await expectCode(
      assign(c.K.p, c.org, c.A.memberId, c.roles.c0.publicId),
      403,
      'owner_only',
    );
    expect((await remove(c.K.p, c.org, c.A.memberId)).status).toBe(403);
  });
  it('B-19: an ADMIN assigns a custom role equal to ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(
      assign(c.A.p, c.org, c.M.memberId, c.roles.vPrime.publicId),
      403,
      'owner_only',
    );
  });
  it('B-22 (direct paths): X assigns ADMIN, demotes or removes an ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(
      assign(c.X.p, c.org, c.M.memberId, c.org.roles.ADMIN.publicId),
      403,
      'owner_only',
    );
    await expectCode(
      assign(c.X.p, c.org, c.A.memberId, c.org.roles.MEMBER.publicId),
      403,
      'owner_only',
    );
    await expectCode(remove(c.X.p, c.org, c.A.memberId), 403, 'owner_only');
  });
  it('B-23 (direct): X assigns V′ ≡ ADMIN (created by the owner) → 403 owner_only; the owner can', async () => {
    const c = await cast();
    await expectCode(
      assign(c.X.p, c.org, c.M.memberId, c.roles.vPrime.publicId),
      403,
      'owner_only',
    );
    await expectCode(
      assign(c.O, c.org, c.M.memberId, c.roles.vPrime.publicId),
      200,
      undefined,
    );
  });
  it('B-24 (demote/remove): X demotes or removes Bob who holds V ≡ ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(
      assign(c.X.p, c.org, c.Bob.memberId, c.roles.c0.publicId),
      403,
      'owner_only',
    );
    await expectCode(remove(c.X.p, c.org, c.Bob.memberId), 403, 'owner_only');
  });
  it('R-8: an ADMIN adding a key it lacks (payroll.read) to a role → 403 escalation_denied', async () => {
    const c = await cast();
    const r = await authed(app, c.A.p)
      .patch(`/v1/orgs/${c.org.orgId}/roles/${c.roles.c0.publicId}`)
      .set('if-match', '*')
      .send({ permissions: ['org.read', 'payroll.read'] });
    expect([r.status, r.body.code]).toEqual([403, 'escalation_denied']);
  });
  it('R-19: X creates a role equal to (or above) ADMIN, edits or deletes V′ → 403 owner_only; the owner does the same → 201/200/204', async () => {
    const c = await cast();
    const post = (as: SeededPrincipal, permissions: string[]) =>
      authed(app, as)
        .post(`/v1/orgs/${c.org.orgId}/roles`)
        .set('idempotency-key', `k-${v7()}`)
        .send({ name: `R19 ${v7()}`, permissions });
    const url = `/v1/orgs/${c.org.orgId}/roles/${c.roles.vPrime.publicId}`;
    await expectCode(post(c.X.p, ADMIN_KEYS), 403, 'owner_only');
    await expectCode(
      post(c.X.p, [...ADMIN_KEYS, 'payroll.read']),
      403,
      'owner_only',
    );
    await expectCode(
      authed(app, c.X.p)
        .patch(url)
        .set('if-match', '*')
        .send({ permissions: ROLE_SET_C0 }),
      403,
      'owner_only',
    );
    await expectCode(authed(app, c.X.p).delete(url), 403, 'owner_only');
    expect((await post(c.O, ADMIN_KEYS)).status).toBe(201);
    expect(
      (
        await authed(app, c.O)
          .patch(url)
          .set('if-match', '*')
          .send({ name: 'V prime renamed' })
      ).status,
    ).toBe(200);
    expect((await authed(app, c.O).delete(url)).status).toBe(204);
  });
  it('Review Focus 5: a role id of another org is not assignable → 422 validation_failed', async () => {
    const a = await cast();
    const b = await cast();
    await expectCode(
      assign(a.O, a.org, a.M.memberId, b.roles.c0.publicId),
      422,
      'validation_failed',
    );
  });
});
