import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
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
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('ownership transfer (spec SP3 §9.3, §12; §18.3 O-6, O-7, O-8, O-16; Review Focus 5)', () => {
  let app: INestApplication;
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, M member (người nhận mặc định). */
  const cast = async (opts: { sessionAgeSec?: number } = {}) => {
    const O = await seedP(opts);
    const org = await seedOrg({
      owner: { authUserId: O.authUserId },
      name: 'Handover',
    });
    orgs.push(org);
    const A = await seedP(opts);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP(opts);
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const base = (org: SeededOrg) => `/v1/orgs/${org.orgId}/ownership-transfers`;
  const request = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p)
      .post(base(org))
      .set('idempotency-key', `k-${v7()}`)
      .send(body);
  const act = (
    p: SeededPrincipal,
    org: SeededOrg,
    id: string,
    verb: 'accept' | 'decline',
  ) =>
    authed(app, p)
      .post(`${base(org)}/${id}/${verb}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({});
  const roleOf = async (org: SeededOrg, memberId: string) =>
    (
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(
            'SELECT r.system_key FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE m.id = $1',
            [memberId],
          ),
        ),
      )
    ).rows[0]?.system_key;
  const statusOf = async (org: SeededOrg, id: string) =>
    (
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(
            'SELECT status FROM org_ownership_transfers WHERE public_id = $1',
            [id],
          ),
        ),
      )
    ).rows[0]?.status;
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );

  beforeAll(async () => {
    app = await startTenancyApp({
      env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('O-6: request → mail to the recipient → accept with step_down_to=ADMIN; ≥ 1 owner throughout; events and two role_changed', async () => {
    const c = await cast();
    const after = await mail.now();
    const r = await request(c.O, c.org, {
      toMemberId: c.m.memberPublicId,
      stepDownTo: 'ADMIN',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      fromMemberId: c.org.owner.memberPublicId,
      toMemberId: c.m.memberPublicId,
      stepDownTo: 'ADMIN',
      status: 'PENDING',
    });
    const msg = await mail.waitFor(c.M.email, {
      subject: /Ownership transfer requested for Handover/,
      after,
    });
    expect(msg.Text).not.toMatch(/token/i);
    expect(
      (
        await authed(app, c.M).get(`${base(c.org)}?status=PENDING`)
      ).body.data.map((t: { id: string }) => t.id),
    ).toEqual([r.body.id]);
    const ok = await act(c.M, c.org, r.body.id, 'accept');
    expect([ok.status, ok.body.status]).toEqual([200, 'ACCEPTED']);
    expect(await roleOf(c.org, c.m.memberId)).toBe('OWNER');
    expect(await roleOf(c.org, c.org.owner.memberId)).toBe('ADMIN');
    expect((await events(r.body.id)).map((e) => e.type)).toEqual([
      'tenancy.ownership_transfer.requested',
      'tenancy.ownership_transfer.accepted',
    ]);
    const changed = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.role_changed' ORDER BY id`,
      [c.org.orgId],
    );
    expect(
      changed.map((e) => [e.payload['memberId'], e.payload['reason']]),
    ).toEqual([
      [c.m.memberPublicId, 'OWNERSHIP_TRANSFER'],
      [c.org.owner.memberPublicId, 'OWNERSHIP_TRANSFER'],
    ]);
  });
  it('without step_down_to the initiator stays an owner; a recipient who is already an owner lets the initiator step down only', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.a.memberPublicId });
    expect((await act(c.A, c.org, r.body.id, 'accept')).status).toBe(200);
    expect([
      await roleOf(c.org, c.a.memberId),
      await roleOf(c.org, c.org.owner.memberId),
    ]).toEqual(['OWNER', 'OWNER']);
    const down = await request(c.O, c.org, {
      toMemberId: c.a.memberPublicId,
      stepDownTo: 'MEMBER',
    });
    expect((await act(c.A, c.org, down.body.id, 'accept')).status).toBe(200);
    expect(await roleOf(c.org, c.org.owner.memberId)).toBe('MEMBER');
    const roleChanges = await ownerQuery(
      `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.role_changed'`,
      [c.org.orgId],
    );
    expect(roleChanges).toHaveLength(2); // A → OWNER (lần 1), O → MEMBER (lần 2); A đã là OWNER ở lần 2 nên không có event cho A
  });
  it('O-7: a recipient who is not a member, oneself, or whose email is unverified → 422; one PENDING per org → 409', async () => {
    const c = await cast();
    expect((await request(c.O, c.org, { toMemberId: v7() })).body.code).toBe(
      'validation_failed',
    );
    expect(
      (await request(c.O, c.org, { toMemberId: c.org.owner.memberPublicId }))
        .body.code,
    ).toBe('validation_failed');
    const U = await seedP({ emailVerified: false });
    const u = await seedMember(c.org, 'MEMBER', { authUserId: U.authUserId });
    expect(
      (await request(c.O, c.org, { toMemberId: u.memberPublicId })).body.code,
    ).toBe('validation_failed');
    expect(
      (await request(c.O, c.org, { toMemberId: c.m.memberPublicId })).status,
    ).toBe(201);
    expect(
      (await request(c.O, c.org, { toMemberId: c.a.memberPublicId })).body.code,
    ).toBe('ownership_transfer_pending');
    expect(
      (await request(c.A, c.org, { toMemberId: c.m.memberPublicId })).body.code,
    ).toBe('forbidden'); // ownership.transfer là ownerOnly
  });
  it('O-8: requesting with a stale session → 403 reauthentication_required', async () => {
    const c = await cast({ sessionAgeSec: 3600 });
    expect(
      (await request(c.O, c.org, { toMemberId: c.m.memberPublicId })).body.code,
    ).toBe('reauthentication_required');
  });
  it('O-16: the initiator was demoted before the accept → 409 ownership_transfer_invalidated, the request is CANCELLED { INITIATOR_NOT_OWNER } and committed', async () => {
    const c = await cast();
    const O2 = await seedP();
    await seedMember(c.org, 'OWNER', { authUserId: O2.authUserId });
    const r = await request(c.O, c.org, {
      toMemberId: c.m.memberPublicId,
      stepDownTo: 'ADMIN',
    });
    await withAppClient((cl) =>
      inOrgTx(cl, c.org.orgId, () =>
        cl.query('UPDATE org_members SET role_id = $1 WHERE id = $2', [
          c.org.roles.ADMIN.id,
          c.org.owner.memberId,
        ]),
      ),
    );
    const bad = await act(c.M, c.org, r.body.id, 'accept');
    expect([bad.status, bad.body.code]).toEqual([
      409,
      'ownership_transfer_invalidated',
    ]);
    expect(await statusOf(c.org, r.body.id)).toBe('CANCELLED');
    expect(
      (await events(r.body.id)).map((e) => [
        e.type,
        e.payload['reason'] ?? null,
      ]),
    ).toEqual([
      ['tenancy.ownership_transfer.requested', null],
      ['tenancy.ownership_transfer.cancelled', 'INITIATOR_NOT_OWNER'],
    ]);
    expect(await roleOf(c.org, c.m.memberId)).toBe('MEMBER');
  });
  it('Review Focus 5: only the recipient can accept or decline; others get 404 and the request stays pending', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId });
    for (const p of [c.O, c.A])
      for (const verb of ['accept', 'decline'] as const)
        expect((await act(p, c.org, r.body.id, verb)).status, `${verb}`).toBe(
          404,
        );
    expect(await statusOf(c.org, r.body.id)).toBe('PENDING');
    const declined = await act(c.M, c.org, r.body.id, 'decline');
    expect([declined.status, declined.body.status]).toEqual([200, 'DECLINED']);
    expect((await act(c.M, c.org, r.body.id, 'accept')).body.code).toBe(
      'ownership_transfer_not_pending',
    );
  });
  it('Review Focus 5: non-owners list only their own requests; owners list all; ?status= filters by the effective status', async () => {
    const c = await cast();
    await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.a.memberId,
      status: 'DECLINED',
    });
    const mine = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
      status: 'CANCELLED',
    });
    const lapsed = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.m.memberId,
      expiresInSec: -60,
    });
    const ids = async (p: SeededPrincipal, q = '') =>
      (
        (await authed(app, p).get(`${base(c.org)}${q}`)).body.data as {
          id: string;
        }[]
      )
        .map((t) => t.id)
        .sort();
    expect(await ids(c.M)).toEqual([mine.publicId, lapsed.publicId].sort());
    expect(await ids(c.O)).toHaveLength(3);
    expect(await ids(c.O, '?status=EXPIRED')).toEqual([lapsed.publicId]);
    expect(await ids(c.O, '?status=PENDING')).toEqual([]);
  });
  it('cancel by an owner: 204 + cancelled { CANCELLED }; a lapsed request → 409 not_pending and EXPIRED without an event', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId });
    expect(
      (await authed(app, c.O).delete(`${base(c.org)}/${r.body.id}`)).status,
    ).toBe(204);
    expect(
      (await events(r.body.id)).map((e) => e.payload['reason'] ?? null),
    ).toEqual([null, 'CANCELLED']);
    const lapsed = await seedTransfer(c.org, {
      fromMemberId: c.org.owner.memberId,
      toMemberId: c.a.memberId,
      expiresInSec: -60,
    });
    expect((await act(c.A, c.org, lapsed.publicId, 'accept')).body.code).toBe(
      'ownership_transfer_not_pending',
    );
    expect(await statusOf(c.org, lapsed.publicId)).toBe('EXPIRED');
    expect(await events(lapsed.publicId)).toEqual([]);
  });
});
