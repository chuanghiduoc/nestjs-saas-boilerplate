import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import {
  acceptInvitation,
  previewToken,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  deleteTenancyUsersOf,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const PASSWORD = 'acquisition-3c correct horse battery';

describe('3C inside the lifecycle of 3A/3B (spec Bảng 5; §9.3, §9.4, §9.6; R-11, R-18, B-15; tiêu chí 8; S2-R43)', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const registered: string[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP();
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{
      type: string;
      aggregate_version: string;
      payload: Record<string, unknown>;
      headers: { actorType: string; actorId: string };
    }>(
      'SELECT type, aggregate_version::text, payload, headers FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );

  beforeAll(async () => {
    app = await startTenancyApp({ env: { HTTP_TRUST_PROXY: 'loopback' } });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf(registered);
    for (const id of registered)
      await ownerQuery('DELETE FROM auth."user" WHERE id = $1', [id]);
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('tiêu chí 8: soft delete revokes pending invitations and every link and cancels pending transfers, without events of their own; restore revives none', async () => {
    const c = await cast();
    const p = await seedP();
    const inv = await seedInvitation(c.org, {
      email: p.email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.a.memberId,
    });
    const link = await seedInviteLink(c.org, {
      roleId: c.org.roles.MEMBER.id,
      createdByMemberId: c.a.memberId,
    });
    const t = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
    });
    expect(
      (await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`)).status,
    ).toBe(204);
    const state = async () => ({
      inv: (
        await sql(
          c.org,
          'SELECT status, token_hash IS NULL AS cleared FROM org_invitations WHERE id = $1',
          [inv.id],
        )
      ).rows[0],
      link: (
        await sql(
          c.org,
          'SELECT revoked_at IS NOT NULL AS revoked FROM org_invite_links WHERE id = $1',
          [link.id],
        )
      ).rows[0],
      t: (
        await sql(
          c.org,
          'SELECT status FROM org_ownership_transfers WHERE id = $1',
          [t.id],
        )
      ).rows[0],
    });
    const revoked = {
      inv: { status: 'REVOKED', cleared: true },
      link: { revoked: true },
      t: { status: 'CANCELLED' },
    };
    expect(await state()).toEqual(revoked);
    for (const id of [inv.publicId, link.publicId, t.publicId])
      expect(await events(id)).toEqual([]);
    const restored = await authed(app, c.O)
      .post(`/v1/orgs/${c.org.orgId}/restore`)
      .set('idempotency-key', `k-${v7()}`)
      .send({});
    expect(restored.status).toBe(200);
    expect(await state()).toEqual(revoked);
    expect(
      (await previewToken(app, 'invitations', { token: inv.token })).status,
    ).toBe(404);
    expect(
      (await previewToken(app, 'invite-links', { token: link.token })).status,
    ).toBe(404);
    expect(
      (await acceptInvitation(app, p, { token: inv.token })).body.code,
    ).toBe('invitation_not_found');
  });
  it('R-11 / B-15: a custom role held by a PENDING invitation or an open link cannot be deleted (409 role_in_use); once revoked it can', async () => {
    const c = await cast();
    const role = await seedCustomRole(c.org, {
      permissions: ROLE_SET_C0,
      name: `R11 ${v7()}`,
    });
    const url = `/v1/orgs/${c.org.orgId}/roles/${role.publicId}`;
    const inv = await seedInvitation(c.org, {
      email: `r11-${v7()}@example.test`,
      roleId: role.id,
      inviterMemberId: c.org.owner.memberId,
    });
    expect((await authed(app, c.O).delete(url)).body.code).toBe('role_in_use');
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`,
        )
      ).status,
    ).toBe(204);
    const link = await seedInviteLink(c.org, {
      roleId: role.id,
      createdByMemberId: c.org.owner.memberId,
    });
    expect((await authed(app, c.O).delete(url)).body.code).toBe('role_in_use');
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/invite-links/${link.publicId}`,
        )
      ).status,
    ).toBe(204);
    expect((await authed(app, c.O).delete(url)).status).toBe(204);
  });
  it('R-18: finished invitations and closed links do not hold a role; lapsed invitations read EXPIRED; each closed link is revoked with ROLE_DELETED', async () => {
    const c = await cast();
    const role = await seedCustomRole(c.org, {
      permissions: ROLE_SET_C0,
      name: `R18 ${v7()}`,
    });
    const base = { roleId: role.id, inviterMemberId: c.org.owner.memberId };
    const accepted = await seedInvitation(c.org, {
      ...base,
      email: `acc-${v7()}@example.test`,
      status: 'ACCEPTED',
    });
    const lapsed = await seedInvitation(c.org, {
      ...base,
      email: `lap-${v7()}@example.test`,
      expiresInSec: -60,
    });
    const linkBase = {
      roleId: role.id,
      createdByMemberId: c.org.owner.memberId,
    };
    const alreadyRevoked = await seedInviteLink(c.org, {
      ...linkBase,
      revoked: true,
    });
    const expired = await seedInviteLink(c.org, {
      ...linkBase,
      expiresInSec: -60,
    });
    const exhausted = await seedInviteLink(c.org, {
      ...linkBase,
      maxUses: 1,
      useCount: 1,
    });
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/roles/${role.publicId}`,
        )
      ).status,
    ).toBe(204);
    const invs = (
      await authed(app, c.O).get(
        `/v1/orgs/${c.org.orgId}/invitations?pageSize=100`,
      )
    ).body.data as { id: string; status: string; role: unknown }[];
    expect(invs.find((i) => i.id === accepted.publicId)).toMatchObject({
      status: 'ACCEPTED',
      role: null,
    });
    expect(invs.find((i) => i.id === lapsed.publicId)).toMatchObject({
      status: 'EXPIRED',
      role: null,
    });
    expect(await events(lapsed.publicId)).toEqual([]);
    for (const l of [expired, exhausted])
      expect(
        (await events(l.publicId)).map((e) => [
          e.type,
          e.payload['reason'],
          e.aggregate_version,
          e.headers.actorId,
        ]),
      ).toEqual([
        ['tenancy.invite_link.revoked', 'ROLE_DELETED', '2', c.O.authUserId],
      ]);
    expect(await events(alreadyRevoked.publicId)).toEqual([]);
    const links = (
      await authed(app, c.O).get(
        `/v1/orgs/${c.org.orgId}/invite-links?pageSize=100`,
      )
    ).body.data as { status: string; role: unknown }[];
    expect(links.map((l) => [l.status, l.role])).toEqual([
      ['REVOKED', null],
      ['REVOKED', null],
      ['REVOKED', null],
    ]);
  });
  it('removing or losing a member of a PENDING transfer cancels it first with { MEMBER_REMOVED } (actor = the remover); a lapsed one only expires', async () => {
    const c = await cast();
    const removed = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
    });
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/members/${c.m.memberPublicId}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (await events(removed.publicId)).map((e) => [
        e.payload['reason'],
        e.headers.actorType,
        e.headers.actorId,
      ]),
    ).toEqual([['MEMBER_REMOVED', 'user', c.O.authUserId]]);
    const O2 = await seedP();
    const o2 = await seedMember(c.org, 'OWNER', { authUserId: O2.authUserId });
    const left = await seedTransfer(c.org, {
      fromMemberId: o2.memberId,
      toMemberId: c.a.memberId,
    });
    expect(
      (await authed(app, O2).delete(`/v1/orgs/${c.org.orgId}/members/me`))
        .status,
    ).toBe(204);
    expect(
      (await events(left.publicId)).map((e) => e.payload['reason']),
    ).toEqual(['MEMBER_REMOVED']);
    const lapsed = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.a.memberId,
      expiresInSec: -60,
    });
    expect(
      (
        await authed(app, c.O).delete(
          `/v1/orgs/${c.org.orgId}/members/${c.a.memberPublicId}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await sql(
          c.org,
          'SELECT status FROM org_ownership_transfers WHERE id = $1',
          [lapsed.id],
        )
      ).rows,
    ).toEqual([{ status: 'EXPIRED' }]);
    expect(await events(lapsed.publicId)).toEqual([]);
  });
  it('account deletion cancels the PENDING transfer of the deleted member ({ MEMBER_REMOVED }, actor system:identity.user-deletion)', async () => {
    const c = await cast();
    const t = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
    });
    const r = await authed(app, admin)
      .post('/api/auth/admin/remove-user')
      .set('origin', 'http://localhost:3000')
      .send({ userId: c.M.authUserId });
    expect(r.status).toBe(200);
    expect(
      (await events(t.publicId)).map((e) => [
        e.payload['reason'],
        e.headers.actorType,
        e.headers.actorId,
      ]),
    ).toEqual([['MEMBER_REMOVED', 'system', 'identity.user-deletion']]);
  });
  it('S2-R43: a user who just signed up accepts an invitation; tenancy never emits identity.user.registered', async () => {
    const c = await cast();
    const email = `s2r43-${randomUUID()}@example.test`;
    const client = new AuthClient(app.getHttpServer());
    const after = await mail.now();
    expect((await client.signUp(email, PASSWORD)).status).toBeLessThan(300);
    await client.verifyEmailFromMailpit(mail, email, after);
    expect((await client.signIn(email, PASSWORD)).status).toBe(200);
    const [row] = await ownerQuery<{ id: string }>(
      'SELECT id FROM auth."user" WHERE email = $1',
      [email],
    );
    if (!row) throw new Error('registered user not found');
    registered.push(row.id);
    const inv = await seedInvitation(c.org, {
      email,
      roleId: c.org.roles.MEMBER.id,
      inviterMemberId: c.a.memberId,
    });
    const r = await client.request('post', '/v1/invitations/accept', {
      body: { token: inv.token },
      headers: { 'idempotency-key': `k-${v7()}` },
    });
    expect(r.status).toBe(201);
    expect(
      (
        await ownerQuery(
          `SELECT 1 FROM outbox_events WHERE type = 'identity.user.registered' AND aggregate_id = $1`,
          [row.id],
        )
      ).length,
    ).toBe(1);
  });
});
