import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  ROLE_SET_C2,
  adminKeys,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';

const STALE_SEC = 3600;

describe('custom roles API (spec SP3 §8.4 luật 1, 2a, 6; §12; §18.3 R-*)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp của app lúc chạy (R-X24): V ≡ ADMIN, C1 = MEMBER ∪ {members.role.assign}, CW = C1 + roles.write. */
  let ADMIN_KEYS: string[];
  let C1: string[];
  let CW: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, W giữ CW (C1 + roles.write), K giữ C1, Bob giữ V ≡ ADMIN (owner tạo). */
  const cast = async (opts: { sessionAgeSec?: number } = {}) => {
    const O = await seedP(opts);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP(opts);
    await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const cw = await seedCustomRole(org, { permissions: CW, name: 'CW' });
    const c1 = await seedCustomRole(org, { permissions: C1, name: 'C1' });
    const v = await seedCustomRole(org, { permissions: ADMIN_KEYS, name: 'V' });
    const W = await seedP(opts);
    await seedMemberInRole(org, cw, { authUserId: W.authUserId });
    const K = await seedP(opts);
    await seedMemberInRole(org, c1, { authUserId: K.authUserId });
    const Bob = await seedP(opts);
    await seedMemberInRole(org, v, { authUserId: Bob.authUserId });
    return { org, O, A, W, K, Bob, cw, c1, v };
  };
  const url = (org: SeededOrg, role?: SeededRole | string) =>
    `/v1/orgs/${org.orgId}/roles${role === undefined ? '' : `/${typeof role === 'string' ? role : role.publicId}`}`;
  const create = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p)
      .post(url(org))
      .set('idempotency-key', `k-${v7()}`)
      .send(body);
  const patch = (
    p: SeededPrincipal,
    org: SeededOrg,
    role: SeededRole | string,
    body: object,
    ifMatch = '*',
  ) => authed(app, p).patch(url(org, role)).set('if-match', ifMatch).send(body);
  const events = (type: string, roleId: string) =>
    ownerQuery<{ aggregate_version: string; payload: unknown }>(
      `SELECT aggregate_version::text, payload FROM outbox_events WHERE type = $1 AND aggregate_id = $2 ORDER BY id`,
      [type, roleId],
    );

  beforeAll(async () => {
    app = await startTenancyApp();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
    CW = [...C1, 'roles.write'].sort();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('R-1: an ADMIN creates a role strictly below itself → 201 + Location + ETag + one tenancy.role.created', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, {
      name: 'Support',
      description: 'Helps',
      permissions: ['members.read', 'org.read'],
    });
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(
      `/v1/orgs/${c.org.orgId}/roles/${r.body.id}`,
    );
    expect(r.headers.etag).toBe('W/"1"'); // ETag yếu của `etagOf` (ADR 0007)
    expect(r.body).toMatchObject({
      systemKey: null,
      name: 'Support',
      description: 'Helps',
      permissions: ['members.read', 'org.read'],
    });
    expect(await events('tenancy.role.created', r.body.id)).toEqual([
      {
        aggregate_version: '1',
        payload: {
          roleId: r.body.id,
          permissions: ['members.read', 'org.read'],
        },
      },
    ]);
  });
  it.each([
    [
      'R-2 ownerOnly',
      ['org.read', 'org.delete'],
      'permission_not_delegable',
      ['org.delete'],
    ],
    [
      'R-5 missing requires',
      ['members.role.assign'],
      'missing_dependencies',
      ['members.read', 'roles.read'],
    ],
    ['R-6 unknown', ['ghost.read'], 'unknown_permission', ['ghost.read']],
    ['R-7 manage', ['org.manage'], 'unknown_permission', ['org.manage']],
  ] as const)(
    '%s → 422 %s listing the keys',
    async (_n, permissions, code, keys) => {
      const c = await cast();
      const r = await create(c.O, c.org, { name: `R ${v7()}`, permissions });
      expect([r.status, r.body.code]).toEqual([422, code]);
      expect(r.body.errors.map((e: { message: string }) => e.message)).toEqual(
        keys,
      );
    },
  );
  it('R-7: a wildcard is not even a permission key → 422 validation_failed', async () => {
    const c = await cast();
    const r = await create(c.O, c.org, { name: 'Star', permissions: ['*'] });
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
  });
  it('R-3: a C1 holder (no roles.write) → 403 forbidden at the guard', async () => {
    const c = await cast();
    expect(
      (await create(c.K, c.org, { name: 'x', permissions: ['org.read'] })).body
        .code,
    ).toBe('forbidden');
  });
  it('R-4: CW creating a role with a key it lacks (C2) → 403 escalation_denied; R-15: CW creating its own set → 403 escalation_denied; an ADMIN creating the ADMIN set → 403 owner_only', async () => {
    const c = await cast();
    expect(
      (await create(c.W, c.org, { name: 'C2', permissions: ROLE_SET_C2 })).body
        .code,
    ).toBe('escalation_denied');
    expect(
      (await create(c.W, c.org, { name: 'Clone', permissions: CW })).body.code,
    ).toBe('escalation_denied');
    expect(
      (
        await create(c.A, c.org, {
          name: 'Admin clone',
          permissions: ADMIN_KEYS,
        })
      ).body.code,
    ).toBe('owner_only');
  });
  it('R-9: CW editing CW (its own role) → 403 cannot_edit_own_role, even to narrow it', async () => {
    const c = await cast();
    const r = await patch(c.W, c.org, c.cw, { permissions: ROLE_SET_C0 });
    expect([r.status, r.body.code]).toEqual([403, 'cannot_edit_own_role']);
  });
  it('R-10: PATCH or DELETE of a system role → 409 system_role_immutable', async () => {
    const c = await cast();
    expect(
      (
        await patch(c.O, c.org, c.org.roles.MEMBER.publicId, {
          name: 'Members',
        })
      ).body.code,
    ).toBe('system_role_immutable');
    expect(
      (await authed(app, c.O).delete(url(c.org, c.org.roles.ADMIN.publicId)))
        .body.code,
    ).toBe('system_role_immutable');
  });
  it('R-11 (member part, T-9): deleting a role that a member holds → 409 role_in_use; the role stays', async () => {
    const c = await cast();
    const r = await authed(app, c.O).delete(url(c.org, c.c1));
    expect([r.status, r.body.code]).toEqual([409, 'role_in_use']);
    expect((await authed(app, c.O).get(url(c.org, c.c1))).status).toBe(200);
  });
  it('R-12: CW deleting an unused role larger than C1 → 403 escalation_denied; deleting an unused smaller role → 204 + tenancy.role.deleted', async () => {
    const c = await cast();
    const big = await seedCustomRole(c.org, {
      permissions: [...CW, 'invitations.read'],
      name: 'Big',
    });
    expect((await authed(app, c.W).delete(url(c.org, big))).body.code).toBe(
      'escalation_denied',
    );
    const small = await seedCustomRole(c.org, {
      permissions: ROLE_SET_C0,
      name: 'Small',
    });
    expect((await authed(app, c.W).delete(url(c.org, small))).status).toBe(204);
    expect(await events('tenancy.role.deleted', small.publicId)).toEqual([
      { aggregate_version: '2', payload: { roleId: small.publicId } },
    ]);
  });
  it('R-13: a role of org B through the path of org A → 404', async () => {
    const a = await cast();
    const b = await cast();
    expect((await patch(a.O, a.org, b.c1, { name: 'x' })).status).toBe(404);
    expect((await authed(app, a.O).delete(url(a.org, b.c1))).status).toBe(404);
  });
  it('R-14 (API): the owner removes members.read from C1 → the C1 holder loses it on the next request; one tenancy.role.updated with version 2', async () => {
    const c = await cast();
    expect(
      (await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status,
    ).toBe(200);
    const r = await patch(c.O, c.org, c.c1, {
      permissions: ['org.read', 'roles.read'],
    });
    expect([r.status, r.headers.etag, r.body.permissions]).toEqual([
      200,
      'W/"2"',
      ['org.read', 'roles.read'],
    ]);
    expect(
      (await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status,
    ).toBe(403);
    expect(await events('tenancy.role.updated', c.c1.publicId)).toEqual([
      {
        aggregate_version: '2',
        payload: {
          roleId: c.c1.publicId,
          permissions: ['org.read', 'roles.read'],
        },
      },
    ]);
  });
  it('R-16: an ADMIN narrowing V ≡ ADMIN held by Bob → 403 owner_only; Bob keeps members.remove', async () => {
    const c = await cast();
    expect(
      (await patch(c.A, c.org, c.v, { permissions: ROLE_SET_C0 })).body.code,
    ).toBe('owner_only');
    expect(
      (await authed(app, c.Bob).get(url(c.org, c.v))).body.permissions,
    ).toEqual(ADMIN_KEYS);
  });
  it('R-17: CW narrowing a role larger than itself → 403 escalation_denied', async () => {
    const c = await cast();
    const big = await seedCustomRole(c.org, {
      permissions: [...CW, 'invitations.read'],
      name: 'Big2',
    });
    expect(
      (await patch(c.W, c.org, big, { permissions: ROLE_SET_C0 })).body.code,
    ).toBe('escalation_denied');
  });
  it('R-20: PATCH, POST and DELETE of roles with a stale session → 403 reauthentication_required', async () => {
    const c = await cast({ sessionAgeSec: STALE_SEC });
    expect((await patch(c.O, c.org, c.c1, { name: 'Stale' })).body.code).toBe(
      'reauthentication_required',
    );
    expect(
      (await create(c.O, c.org, { name: 'Stale', permissions: ['org.read'] }))
        .body.code,
    ).toBe('reauthentication_required');
    expect((await authed(app, c.O).delete(url(c.org, c.cw))).body.code).toBe(
      'reauthentication_required',
    );
  });

  describe('Review Focus', () => {
    it('1: role names are case-insensitive per org, trimmed and counted in code points', async () => {
      const c = await cast();
      expect(
        (await create(c.O, c.org, { name: 'Billing', permissions: [] })).status,
      ).toBe(201);
      expect(
        (await create(c.O, c.org, { name: 'BILLING', permissions: [] })).body
          .code,
      ).toBe('role_name_taken');
      const other = await cast();
      expect(
        (await create(other.O, other.org, { name: 'BILLING', permissions: [] }))
          .status,
      ).toBe(201);
      expect(
        (await create(c.O, c.org, { name: ' Spaced', permissions: [] })).body
          .code,
      ).toBe('validation_failed');
      expect(
        (await create(c.O, c.org, { name: '😀'.repeat(64), permissions: [] }))
          .status,
      ).toBe(201);
      expect(
        (await create(c.O, c.org, { name: '😀'.repeat(65), permissions: [] }))
          .body.code,
      ).toBe('validation_failed');
    });
    it('2: a PATCH that changes nothing (same set in another order, duplicates, same name) keeps the version and publishes no event', async () => {
      const c = await cast();
      // Cùng tập C1, thứ tự đảo, lặp một key.
      const r = await patch(c.O, c.org, c.c1, {
        name: 'C1',
        permissions: [...[...C1].reverse(), C1[0]],
      });
      expect([r.status, r.headers.etag]).toEqual([200, 'W/"1"']);
      expect(await events('tenancy.role.updated', c.c1.publicId)).toEqual([]);
    });
    it('3: If-Match on PATCH roles: missing 428, stale 412, "1" and W/"1" accepted; description null clears it', async () => {
      const c = await cast();
      expect(
        (await authed(app, c.O).patch(url(c.org, c.c1)).send({ name: 'x' }))
          .status,
      ).toBe(428);
      expect(
        (await patch(c.O, c.org, c.c1, { name: 'Renamed' }, '"7"')).status,
      ).toBe(412);
      const ok = await patch(
        c.O,
        c.org,
        c.c1,
        { description: 'Temp' },
        'W/"1"',
      );
      expect([ok.status, ok.headers.etag]).toEqual([200, 'W/"2"']);
      const cleared = await patch(
        c.O,
        c.org,
        c.c1,
        { description: null },
        '"2"',
      );
      expect([cleared.status, cleared.body.description]).toEqual([200, null]);
      expect((await patch(c.O, c.org, c.c1, { name: null })).body.code).toBe(
        'validation_failed',
      );
    });
    it('4: an empty role is allowed and grants nothing', async () => {
      const c = await cast();
      const r = await create(c.O, c.org, { name: 'Nothing', permissions: [] });
      expect([r.status, r.body.permissions]).toEqual([201, []]);
      const p = await seedP();
      // `org_roles` là FORCE RLS: id nội bộ đọc bằng app_user trong OrgScope của org (owner thấy 0 dòng).
      const [row] = await withAppClient((db) =>
        inOrgTx(
          db,
          c.org.orgId,
          async () =>
            (
              await db.query<{ id: string }>(
                `SELECT id::text AS id FROM org_roles WHERE public_id = $1`,
                [r.body.id],
              )
            ).rows,
        ),
      );
      await seedMemberInRole(
        c.org,
        { id: row!.id, publicId: r.body.id, name: 'Nothing' },
        { authUserId: p.authUserId },
      );
      expect(
        (await authed(app, p).get(`/v1/orgs/${c.org.orgId}/members/me`)).status,
      ).toBe(200);
      expect(
        (await authed(app, p).get(`/v1/orgs/${c.org.orgId}`)).body.code,
      ).toBe('forbidden');
    });
    it('5: role ids that are not UUIDs are 404, never 500', async () => {
      const c = await cast();
      expect(
        (await authed(app, c.O).get(url(c.org, 'not-a-uuid'))).status,
      ).toBe(404);
      expect(
        (await patch(c.O, c.org, 'not-a-uuid', { name: 'x' })).status,
      ).toBe(404);
      expect(
        (await authed(app, c.O).delete(url(c.org, 'not-a-uuid'))).status,
      ).toBe(404);
    });
  });
});
