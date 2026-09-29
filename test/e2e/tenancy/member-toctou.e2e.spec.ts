import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenancyTestHooks } from '../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedMember,
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
});
