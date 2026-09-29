import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedMember,
  seedOrg,
  type SeededMember,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
type Person = { p: SeededPrincipal; m: SeededMember };

describe('members API (spec SP3 §8.4, §12)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const at = <T>(xs: readonly T[], i: number): T => {
    const x = xs[i];
    if (x === undefined) throw new Error(`cast: no person at ${i}`);
    return x;
  };
  /** Org với một người giữ mỗi role hệ thống (owner thứ hai khi cần). */
  const cast = async (extra: Role[] = []) => {
    const o = await seedP();
    const org = await seedOrg({ owner: { authUserId: o.authUserId } });
    orgs.push(org);
    const people: Person[] = [];
    for (const role of ['ADMIN', 'MEMBER', ...extra] as Role[]) {
      const p = await seedP();
      people.push({
        p,
        m: await seedMember(org, role, { authUserId: p.authUserId }),
      });
    }
    return {
      org,
      owner: { p: o, m: org.owner },
      admin: at(people, 0),
      member: at(people, 1),
      extra: people.slice(2),
    };
  };
  const patchRole = (
    as: SeededPrincipal,
    org: SeededOrg,
    target: SeededMember,
    role: Role,
    ifMatch = '*',
  ) =>
    authed(app, as)
      .patch(`/v1/orgs/${org.orgId}/members/${target.memberPublicId}`)
      .set('if-match', ifMatch)
      .send({ roleId: org.roles[role].publicId });
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('GET members/me returns the caller with userId (tenancy public id), email and name; not swallowed by :memberId', async () => {
    const c = await cast();
    const r = await authed(app, c.member.p).get(
      `/v1/orgs/${c.org.orgId}/members/me`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: c.member.m.memberPublicId,
      userId: c.member.m.userPublicId,
      role: { systemKey: 'MEMBER' },
      email: c.member.p.email,
      name: 'Seeded',
    });
  });
  it('lists members with offset paging and ?roleId=; a non-UUID member id is 404', async () => {
    const c = await cast();
    const all = await authed(app, c.member.p).get(
      `/v1/orgs/${c.org.orgId}/members`,
    );
    expect([all.status, all.body.totalCount]).toEqual([200, 3]);
    const admins = await authed(app, c.member.p).get(
      `/v1/orgs/${c.org.orgId}/members?roleId=${c.org.roles.ADMIN.publicId}`,
    );
    expect(admins.body.data.map((m: { id: string }) => m.id)).toEqual([
      c.admin.m.memberPublicId,
    ]);
    expect(
      (
        await authed(app, c.member.p).get(
          `/v1/orgs/${c.org.orgId}/members/not-a-uuid`,
        )
      ).status,
    ).toBe(404);
  });
  it('GET roles lists the three system roles with their computed permission sets', async () => {
    const c = await cast();
    const r = await authed(app, c.member.p).get(
      `/v1/orgs/${c.org.orgId}/roles`,
    );
    expect(r.body.data.map((x: { systemKey: string }) => x.systemKey)).toEqual([
      'OWNER',
      'ADMIN',
      'MEMBER',
    ]);
    expect(r.body.data[2].permissions).toEqual([
      'members.read',
      'org.read',
      'roles.read',
    ]);
  });
  it.each([
    ['B-4: ADMIN assigns OWNER', 'admin', 'member', 'OWNER', 403, 'owner_only'],
    ['B-5: OWNER assigns OWNER', 'owner', 'member', 'OWNER', 200, undefined],
    [
      'B-18: ADMIN assigns ADMIN',
      'admin',
      'member',
      'ADMIN',
      403,
      'owner_only',
    ],
    [
      'B-8: ADMIN demotes another ADMIN',
      'admin',
      'extra',
      'MEMBER',
      403,
      'owner_only',
    ],
    [
      'B-9: ADMIN demotes an OWNER',
      'admin',
      'owner',
      'MEMBER',
      403,
      'owner_only',
    ],
    [
      'ADMIN promotes nobody past MEMBER → MEMBER is a no-op 200',
      'admin',
      'member',
      'MEMBER',
      200,
      undefined,
    ],
    [
      'MEMBER lacks members.role.assign',
      'member',
      'admin',
      'MEMBER',
      403,
      'forbidden',
    ],
  ] as const)('%s → %i %s', async (_name, as, target, role, status, code) => {
    const c = await cast(['ADMIN']);
    const who = {
      owner: c.owner,
      admin: c.admin,
      member: c.member,
      extra: at(c.extra, 0),
    };
    const r = await patchRole(who[as].p, c.org, who[target].m, role);
    expect(r.status).toBe(status);
    if (code) expect(r.body.code).toBe(code);
  });
  it('B-6: nobody changes their own role, owners included → 403 cannot_change_own_role', async () => {
    const c = await cast();
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const)
      expect(
        (await patchRole(c.owner.p, c.org, c.owner.m, role)).body.code,
      ).toBe('cannot_change_own_role');
    expect(
      (await patchRole(c.admin.p, c.org, c.admin.m, 'MEMBER')).body.code,
    ).toBe('cannot_change_own_role');
  });
  it('member role change honours If-Match (Review Focus 4): missing 428, stale 412', async () => {
    const c = await cast();
    const url = `/v1/orgs/${c.org.orgId}/members/${c.member.m.memberPublicId}`;
    expect(
      (
        await authed(app, c.owner.p)
          .patch(url)
          .send({ roleId: c.org.roles.ADMIN.publicId })
      ).status,
    ).toBe(428);
    expect(
      (await patchRole(c.owner.p, c.org, c.member.m, 'ADMIN', 'W/"1"')).status,
    ).toBe(200);
    expect(
      (await patchRole(c.owner.p, c.org, c.member.m, 'MEMBER', 'W/"1"')).status,
    ).toBe(412);
  });
  it('O-1: the sole owner cannot leave or remove themselves (409 last_owner); self-demotion hits rule 3 first', async () => {
    const c = await cast();
    const leave = await authed(app, c.owner.p).delete(
      `/v1/orgs/${c.org.orgId}/members/me`,
    );
    expect([leave.status, leave.body.code]).toEqual([409, 'last_owner']);
    const self = await authed(app, c.owner.p).delete(
      `/v1/orgs/${c.org.orgId}/members/${c.owner.m.memberPublicId}`,
    );
    expect([self.status, self.body.code]).toEqual([409, 'last_owner']);
    expect(
      (await patchRole(c.owner.p, c.org, c.owner.m, 'ADMIN')).body.code,
    ).toBe('cannot_change_own_role');
  });
  it('a MEMBER leaves with an old session (narrowing route, no fresh session); ADMIN removes a MEMBER', async () => {
    const c = await cast(['MEMBER']);
    const old = await seedP({ sessionAgeSec: 7200 });
    await seedMember(c.org, 'MEMBER', { authUserId: old.authUserId });
    expect(
      (await authed(app, old).delete(`/v1/orgs/${c.org.orgId}/members/me`))
        .status,
    ).toBe(204);
    expect(
      (
        await authed(app, c.admin.p).delete(
          `/v1/orgs/${c.org.orgId}/members/${at(c.extra, 0).m.memberPublicId}`,
        )
      ).status,
    ).toBe(204);
    const events = await ownerQuery<{
      type: string;
      payload: { reason: string };
    }>(
      `SELECT type, payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.removed' ORDER BY id`,
      [c.org.orgId],
    );
    expect(events.map((e) => e.payload.reason)).toEqual(['LEFT', 'REMOVED']);
  });
  it('O-10: on a soft-deleted org, changing an owner is the uniform 404 (only restore passes the middleware)', async () => {
    const c = await cast(['OWNER']);
    await authed(app, c.owner.p).delete(`/v1/orgs/${c.org.orgId}`).expect(204);
    expect(
      (await patchRole(c.owner.p, c.org, at(c.extra, 0).m, 'MEMBER')).status,
    ).toBe(404);
    expect(
      (
        await authed(app, c.owner.p).delete(
          `/v1/orgs/${c.org.orgId}/members/${at(c.extra, 0).m.memberPublicId}`,
        )
      ).status,
    ).toBe(404);
  });
  it('O-9: only a member row can hold OWNER — org_members has no column for keys or grants', async () => {
    const cols = await ownerQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_members' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at',
      'id',
      'org_id',
      'public_id',
      'role_id',
      'updated_at',
      'user_id',
      'version',
    ]);
  });
  it('O-15: promoting to OWNER or demoting/removing an owner with a stale session → 403 reauthentication_required', async () => {
    const c = await cast(['OWNER']);
    const stale = await seedP({ sessionAgeSec: 7200 });
    await seedMember(c.org, 'OWNER', { authUserId: stale.authUserId });
    expect((await patchRole(stale, c.org, c.member.m, 'OWNER')).body.code).toBe(
      'reauthentication_required',
    );
    expect(
      (await patchRole(stale, c.org, at(c.extra, 0).m, 'ADMIN')).body.code,
    ).toBe('reauthentication_required');
    expect(
      (
        await authed(app, stale).delete(
          `/v1/orgs/${c.org.orgId}/members/${at(c.extra, 0).m.memberPublicId}`,
        )
      ).body.code,
    ).toBe('reauthentication_required');
  });
});
