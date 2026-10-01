import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  joinInviteLink,
  previewToken,
  problemCore,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  adminKeys,
  inOrgTx,
  newToken,
  seedCustomRole,
  seedInviteLink,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import {
  PayrollPermissionsModule,
  installPayrollPermission,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

const MAX_TTL_SEC = 86_400;
const MAX_USES_LIMIT = 50;
const ACTIVE_CAP = 2;

describe('invite links (spec SP3 §9.2, §12; §18.3 B-11, B-14, B-22/B-23; Review Focus 4)', () => {
  let app: INestApplication;
  let ADMIN_KEYS: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({
      owner: { authUserId: O.authUserId },
      name: 'Linkco',
    });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const vPrime = await seedCustomRole(org, {
      permissions: ADMIN_KEYS,
      name: `V' ${v7()}`,
    });
    const x = await seedCustomRole(org, {
      permissions: [...ADMIN_KEYS, 'payroll.read'],
      name: `X ${v7()}`,
    });
    const Xp = await seedP();
    await seedMemberInRole(org, x, { authUserId: Xp.authUserId });
    return { org, O, A, aMemberId: a.memberId, vPrime, Xp };
  };
  const inHours = (h: number) =>
    new Date(Date.now() + h * 3_600_000).toISOString();
  const create = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/invite-links`).send(body);
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );
  const tokenOf = (url: string) => {
    const t = /#token=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
    if (!t) throw new Error('invite link url without #token=');
    return t;
  };

  beforeAll(async () => {
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: {
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_INVITE_LINK_MAX_TTL_SEC: String(MAX_TTL_SEC),
        TENANCY_INVITE_LINK_MAX_USES_LIMIT: String(MAX_USES_LIMIT),
        TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG: String(ACTIVE_CAP),
      },
    });
    ADMIN_KEYS = adminKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await removePayrollPermission();
    vi.unstubAllEnvs();
  });

  it('create → 201 with the url exactly once (no-store, never in the list); preview; join → 201 member; one event each', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, {
      roleId: c.org.roles.MEMBER.publicId,
      maxUses: 3,
      expiresAt: inHours(2),
    });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/invite-links/${r.body.id}`,
    );
    expect(r.body).toMatchObject({
      status: 'ACTIVE',
      maxUses: 3,
      useCount: 0,
      role: { systemKey: 'MEMBER' },
    });
    expect(r.body.url).toMatch(
      /^http:\/\/localhost:3000\/join#token=[A-Za-z0-9_-]{43}$/,
    );
    const token = tokenOf(r.body.url);
    const listed = await authed(app, c.A).get(
      `/v1/orgs/${c.org.orgId}/invite-links`,
    );
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect((await previewToken(app, 'invite-links', { token })).body).toEqual({
      orgName: 'Linkco',
      roleName: 'Member',
      expiresAt: r.body.expiresAt,
    });
    const joiner = await seedP();
    const joined = await joinInviteLink(app, joiner, { token });
    expect(joined.status).toBe(201);
    expect(joined.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/members/${joined.body.id}`,
    );
    expect((await events(r.body.id)).map((e) => e.type)).toEqual([
      'tenancy.invite_link.created',
    ]);
    expect(
      (await events(joined.body.id)).map((e) => [
        e.payload['source'],
        e.payload['inviteLinkId'],
      ]),
    ).toEqual([['INVITE_LINK', r.body.id]]);
    expect(
      (await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/invite-links`)).body
        .data[0],
    ).toMatchObject({ useCount: 1, status: 'ACTIVE' });
  });
  it('Review Focus 4: link TTL and max uses at the boundaries', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.publicId;
    for (const expiresAt of [
      new Date(Date.now() - 1000).toISOString(),
      new Date().toISOString(),
      new Date(Date.now() + (MAX_TTL_SEC + 60) * 1000).toISOString(),
    ])
      expect(
        (await create(c.A, c.org, { roleId: role, maxUses: 1, expiresAt })).body
          .code,
        expiresAt,
      ).toBe('ttl_out_of_range');
    for (const maxUses of [0, -1, MAX_USES_LIMIT + 1, 1.5])
      expect(
        (
          await create(c.A, c.org, {
            roleId: role,
            maxUses,
            expiresAt: inHours(1),
          })
        ).body.code,
        String(maxUses),
      ).toBe('validation_failed');
    expect(
      (
        await create(c.A, c.org, {
          roleId: role,
          maxUses: MAX_USES_LIMIT,
          expiresAt: inHours(MAX_TTL_SEC / 3600 - 1),
        })
      ).status,
    ).toBe(201);
  });
  it('Review Focus 4: an exhausted link frees a slot of the open-link cap; a second join of a maxUses=1 link is 404 and the link reads EXHAUSTED', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.publicId;
    const one = await create(c.A, c.org, {
      roleId: role,
      maxUses: 1,
      expiresAt: inHours(1),
    });
    expect(
      (
        await create(c.A, c.org, {
          roleId: role,
          maxUses: 5,
          expiresAt: inHours(1),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await create(c.A, c.org, {
          roleId: role,
          maxUses: 5,
          expiresAt: inHours(1),
        })
      ).body.code,
    ).toBe('invite_links_limit');
    expect(
      (
        await joinInviteLink(app, await seedP(), {
          token: tokenOf(one.body.url),
        })
      ).status,
    ).toBe(201);
    const second = await joinInviteLink(app, await seedP(), {
      token: tokenOf(one.body.url),
    });
    expect([second.status, second.body.code]).toEqual([
      404,
      'invite_link_not_found',
    ]);
    const listed = (
      await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/invite-links`)
    ).body.data as { id: string; status: string }[];
    expect(listed.find((l) => l.id === one.body.id)?.status).toBe('EXHAUSTED');
    expect(
      (
        await create(c.A, c.org, {
          roleId: role,
          maxUses: 5,
          expiresAt: inHours(1),
        })
      ).status,
    ).toBe(201); // EXHAUSTED không chiếm trần
  });
  it('Review Focus 3 (links): garbage tokens are 422 or the uniform 404, never 500', async () => {
    const p = await seedP();
    for (const body of [
      {},
      { token: '' },
      { token: 'y'.repeat(10_000) },
      { token: '!!' },
      { token: 7 },
      null,
    ] as unknown[]) {
      expect((await previewToken(app, 'invite-links', body)).status).toBe(422);
      expect((await joinInviteLink(app, p, body)).status).toBe(422);
    }
    expect(
      (await joinInviteLink(app, p, { token: newToken() })).body.code,
    ).toBe('invite_link_not_found');
  });
  it('unknown, expired, exhausted, revoked and soft-deleted-org links give one identical 404 at preview and join', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.id;
    const expired = await seedInviteLink(c.org, {
      roleId: role,
      createdByMemberId: c.aMemberId,
      expiresInSec: -60,
    });
    const exhausted = await seedInviteLink(c.org, {
      roleId: role,
      createdByMemberId: c.aMemberId,
      maxUses: 1,
      useCount: 1,
    });
    const revoked = await seedInviteLink(c.org, {
      roleId: role,
      createdByMemberId: c.aMemberId,
      revoked: true,
    });
    const gone = await cast();
    const inDeleted = await seedInviteLink(gone.org, {
      roleId: gone.org.roles.MEMBER.id,
      createdByMemberId: gone.aMemberId,
    });
    expect(
      (await authed(app, gone.O).delete(`/v1/orgs/${gone.org.orgId}`)).status,
    ).toBe(204);
    const p = await seedP();
    const all = [];
    for (const token of [
      newToken(),
      expired.token,
      exhausted.token,
      revoked.token,
      inDeleted.token,
    ]) {
      all.push(await previewToken(app, 'invite-links', { token }));
      all.push(await joinInviteLink(app, p, { token }));
    }
    for (const r of all) expect(r.status).toBe(404);
    expect(
      new Set(all.map((r) => JSON.stringify(problemCore(r.body)))).size,
    ).toBe(1);
  });
  it('revoke: 204 + one tenancy.invite_link.revoked { REVOKED }; revoking again is a no-op 204 without a second event', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.aMemberId,
    });
    const url = `/v1/orgs/${c.org.orgId}/invite-links/${link.publicId}`;
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect(
      (await events(link.publicId)).map((e) => [e.type, e.payload['reason']]),
    ).toEqual([['tenancy.invite_link.revoked', 'REVOKED']]);
    expect(
      (await joinInviteLink(app, await seedP(), { token: link.token })).body
        .code,
    ).toBe('invite_link_not_found');
  });
  it('B-11 / B-22 / B-23 (links): OWNER never; X cannot link ADMIN or V′; ADMIN cannot link ADMIN', async () => {
    const c = await cast();
    const body = (roleId: string) => ({
      roleId,
      maxUses: 1,
      expiresAt: inHours(1),
    });
    expect(
      (await create(c.O, c.org, body(c.org.roles.OWNER.publicId))).body.code,
    ).toBe('owner_not_invitable');
    expect(
      (await create(c.Xp, c.org, body(c.org.roles.ADMIN.publicId))).body.code,
    ).toBe('owner_only');
    expect((await create(c.Xp, c.org, body(c.vPrime.publicId))).body.code).toBe(
      'owner_only',
    );
    expect(
      (await create(c.A, c.org, body(c.org.roles.ADMIN.publicId))).body.code,
    ).toBe('owner_only');
  });
  it('B-14: the creator was removed from the organization → join 409 invite_link_invalidated, the link is revoked with { INVALIDATED }, no membership', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.aMemberId,
    });
    await sql(c.org, 'DELETE FROM org_members WHERE id = $1', [c.aMemberId]);
    const joiner = await seedP();
    const r = await joinInviteLink(app, joiner, { token: link.token });
    expect([r.status, r.body.code]).toEqual([409, 'invite_link_invalidated']);
    expect(
      (await events(link.publicId)).map((e) => [e.type, e.payload['reason']]),
    ).toEqual([['tenancy.invite_link.revoked', 'INVALIDATED']]);
    expect(
      (
        await sql(
          c.org,
          'SELECT use_count, revoked_at IS NOT NULL AS revoked FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows,
    ).toEqual([{ use_count: 0, revoked: true }]);
    expect(
      (await joinInviteLink(app, joiner, { token: link.token })).body.code,
    ).toBe('invite_link_not_found');
  });
  it('joining while already a member is 409 already_member and the use count stays (rollback)', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.aMemberId,
      maxUses: 2,
    });
    expect(
      (await joinInviteLink(app, c.A, { token: link.token })).body.code,
    ).toBe('already_member');
    expect(
      (
        await sql(
          c.org,
          'SELECT use_count FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows,
    ).toEqual([{ use_count: 0 }]);
  });
});
