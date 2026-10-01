import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyTestHooks } from '../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
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

/** Seam X-4: chạy một lần hành động của test giữa guard và transaction. */
class ScriptedHooks extends TenancyTestHooks {
  next: (() => Promise<void>) | undefined;
  async afterGuard(): Promise<void> {
    const fn = this.next;
    this.next = undefined;
    await fn?.();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}

describe('X-4 / T-10: the actor is re-read inside the transaction (spec SP3 §8.6)', () => {
  const hooks = new ScriptedHooks();
  let app: INestApplication;
  let org: SeededOrg;
  const principals: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({
      configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks),
    });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('an ADMIN demoted to MEMBER after the guard is refused with 403 by the in-transaction check', async () => {
    const owner = await seedUserPrincipal();
    const admin = await seedUserPrincipal();
    const target = await seedUserPrincipal();
    principals.push(owner, admin, target);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const am = await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    const tm = await seedMember(org, 'MEMBER', {
      authUserId: target.authUserId,
    });
    hooks.next = async () => {
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query('UPDATE org_members SET role_id = $1 WHERE id = $2', [
            org.roles.MEMBER.id,
            am.memberId,
          ]),
        ),
      );
    };
    const r = await authed(app, admin).delete(
      `/v1/orgs/${org.orgId}/members/${tm.memberPublicId}`,
    );
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(
      (
        await authed(app, admin).get(
          `/v1/orgs/${org.orgId}/members/${tm.memberPublicId}`,
        )
      ).status,
    ).toBe(200);
  });
  it('a custom role the actor holds loses members.role.assign after the guard → 403 from the in-transaction check; the target keeps its role', async () => {
    const owner = await seedUserPrincipal();
    const actor = await seedUserPrincipal();
    const target = await seedUserPrincipal();
    principals.push(owner, actor, target);
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    // C1 của catalogue gộp thật (R-X24): trội MEMBER, nên chỉ việc mất members.role.assign mới làm ca này 403.
    const assigner = await seedCustomRole(o, {
      permissions: roleSetC1(app.get(PermissionCatalogueRegistry).merged()),
      name: 'Assigner',
    });
    const c0 = await seedCustomRole(o, {
      permissions: ROLE_SET_C0,
      name: 'C0',
    });
    await seedMemberInRole(o, assigner, { authUserId: actor.authUserId });
    const tm = await seedMember(o, 'MEMBER', { authUserId: target.authUserId });
    // Tập còn lại {org.read, members.read, roles.read, …} vẫn đóng: trigger closure cho COMMIT.
    hooks.next = async () => {
      await withAppClient((c) =>
        inOrgTx(c, o.orgId, () =>
          c.query(
            `DELETE FROM org_role_permissions rp USING permissions p WHERE p.id = rp.permission_id AND rp.role_id = $1 AND p.key = 'members.role.assign'`,
            [assigner.id],
          ),
        ),
      );
    };
    try {
      const r = await authed(app, actor)
        .patch(`/v1/orgs/${o.orgId}/members/${tm.memberPublicId}`)
        .set('if-match', '*')
        .send({ roleId: c0.publicId });
      expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
      expect(hooks.next).toBeUndefined(); // seam đã chạy: guard đã cho qua với tập cũ
      const after = await authed(app, owner).get(
        `/v1/orgs/${o.orgId}/members/${tm.memberPublicId}`,
      );
      expect(after.body.role).toMatchObject({
        id: o.roles.MEMBER.publicId,
        systemKey: 'MEMBER',
      });
    } finally {
      hooks.next = undefined;
      await o.dispose();
    }
  });
});
