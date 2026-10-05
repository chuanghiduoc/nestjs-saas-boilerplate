import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  apiKeyEligibleKeys,
  inOrgTx,
  seedCustomRole,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const HEADER = 'x-api-key';
const MISS_LIMIT = 3;

describe('org API key authentication and confinement (spec SP3 §7.1 bước 2, 3.6, 3.7; §10; §18.2; §18.3 K-4–K-7, K-10, K-13, K-14, B-17; Review Focus 1)', () => {
  let app: INestApplication;
  let full: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const keyGet = (token: string, url: string) =>
    request(app.getHttpServer()).get(url).set(HEADER, token);
  const setup = async () => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedUserPrincipal();
    principals.push(A);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const key = await seedOrgApiKey(org, {
      createdByMemberId: a.memberId,
      permissions: full,
    });
    return { org, O, A, a, key };
  };
  /** org_members là FORCE RLS: đổi role bằng app_user trong OrgScope (app_owner không có context thì không thấy dòng nào). */
  const setRole = async (org: SeededOrg, memberId: string, roleId: string) => {
    const r = await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [
          roleId,
          memberId,
        ]),
      ),
    );
    expect(r.rowCount).toBe(1);
  };

  beforeAll(async () => {
    app = await startTenancyApp({
      env: { TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT) },
    });
    full = apiKeyEligibleKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a valid key reads its org (via ORG_API_KEY); it never authenticates on Better Auth', async () => {
    const s = await setup();
    const r = await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`);
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-limit']).toBeDefined(); // throttler khoá `principal:api_key:<id>:<org>`
  });
  it('K-4/K-5/T-30: the creator demoted → the route needing the lost permission 403; promoted again → 200 at the next request', async () => {
    const s = await setup();
    // MEMBER giữ mọi quyền key-eligible có route (org.read, members.read, roles.read): hạ về role tuỳ biến không có roles.read.
    const narrow = await seedCustomRole(s.org, {
      name: 'no-roles',
      permissions: ['org.read', 'members.read'],
    });
    const roles = `/v1/orgs/${s.org.orgId}/roles`;
    expect((await keyGet(s.key.token, roles)).status).toBe(200);
    await setRole(s.org, s.a.memberId, narrow.id);
    expect(
      (await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status,
    ).toBe(200);
    const demoted = await keyGet(s.key.token, roles);
    expect([demoted.status, demoted.body.code]).toEqual([403, 'forbidden']);
    await setRole(s.org, s.a.memberId, s.org.roles.ADMIN.id);
    expect((await keyGet(s.key.token, roles)).status).toBe(200);
  });
  it('K-7: a valid key on another org → the same 404 as a non-member, counted by the org-miss limiter, then 429', async () => {
    const s = await setup();
    const other = await setup();
    const miss = await keyGet(
      s.key.token,
      `/v1/orgs/${other.org.orgId}/members`,
    );
    expect([miss.status, miss.body.code]).toEqual([404, 'not_found']);
    expect(miss.headers['x-ratelimit-limit']).toBeUndefined();
    // Hợp đồng `RateLimitBucket` (org-miss-limiter.e2e): LIMIT + 1 lần trượt đều 404, lần LIMIT + 2 mới bị chặn ở peek.
    for (let i = 1; i <= MISS_LIMIT; i++)
      await keyGet(s.key.token, `/v1/orgs/${other.org.orgId}/members`);
    const blocked = await keyGet(
      s.key.token,
      `/v1/orgs/${other.org.orgId}/members`,
    );
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
  });
  it('K-13/T-31: a key of a soft-deleted org → 401; K-14: creator banned or unverified → 401; revoked (T-17) or expired → 401', async () => {
    const s = await setup();
    await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [
      s.A.authUserId,
    ]);
    expect(
      (await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status,
    ).toBe(401);
    await ownerQuery(
      `UPDATE auth."user" SET banned = false, email_verified = false WHERE id = $1`,
      [s.A.authUserId],
    );
    expect(
      (await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status,
    ).toBe(401);
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true WHERE id = $1`,
      [s.A.authUserId],
    );
    expect(
      (await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status,
    ).toBe(200);
    const del = await request(app.getHttpServer())
      .delete(`/v1/orgs/${s.org.orgId}`)
      .set('authorization', `Bearer ${s.O.bearer}`);
    expect(del.status).toBe(204);
    expect(
      (await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status,
    ).toBe(401);
    const t = await setup();
    const revoked = await seedOrgApiKey(t.org, {
      createdByMemberId: t.a.memberId,
      permissions: ['org.read'],
      revoked: true,
    });
    const expired = await seedOrgApiKey(t.org, {
      createdByMemberId: t.a.memberId,
      permissions: ['org.read'],
      expiresInSec: -60,
    });
    for (const k of [revoked, expired])
      expect((await keyGet(k.token, `/v1/orgs/${t.org.orgId}`)).status).toBe(
        401,
      );
  });
  it('Review Focus 1: malformed and case-mangled oak_ keys are a plain 401', async () => {
    const s = await setup();
    // Khoảng trắng đầu/cuối của giá trị header bị parser HTTP bỏ (OWS) nên không phải một biến thể; ký tự xuống dòng không
    // gửi được trong header.
    const variants = [
      `OAK_${s.key.token.slice(4)}`,
      `${s.key.token}x`,
      s.key.token.slice(0, 20),
      `${s.key.token.slice(0, -1)}*`,
      'oak_',
    ];
    for (const v of variants) {
      const r = await keyGet(v, `/v1/orgs/${s.org.orgId}`);
      expect([r.status, r.body.code], JSON.stringify(v)).toEqual([
        401,
        'unauthenticated',
      ]);
    }
  });
  it('confinement: an org key on /v1/me and /v1/orgs → 403 api_key_not_allowed_here; K-10: a Better Auth user key on a tenant route → 403 api_key_not_org_scoped', async () => {
    const s = await setup();
    for (const url of ['/v1/me', '/v1/orgs', '/v1/permissions']) {
      const r = await keyGet(s.key.token, url);
      expect([r.status, r.body.code], url).toEqual([
        403,
        'api_key_not_allowed_here',
      ]);
    }
    const created = await request(app.getHttpServer())
      .post('/api/auth/api-key/create')
      .set('authorization', `Bearer ${s.A.bearer}`)
      .set('origin', 'http://localhost:3000')
      .send({ name: 'user key' });
    expect(created.status).toBe(200);
    const r = await keyGet(String(created.body.key), `/v1/orgs/${s.org.orgId}`);
    expect([r.status, r.body.code]).toEqual([403, 'api_key_not_org_scoped']);
  });
  it('B-17: every binding path called with an org key holding the full eligible scope → 403', async () => {
    const s = await setup();
    const owner = await seedOrgApiKey(s.org, {
      createdByMemberId: s.org.owner.memberId,
      permissions: full,
    });
    const base = `/v1/orgs/${s.org.orgId}`;
    const writes: [string, string, Record<string, unknown>][] = [
      [
        'patch',
        `${base}/members/${s.a.memberPublicId}`,
        { roleId: s.org.roles.MEMBER.publicId },
      ],
      ['post', `${base}/roles`, { name: 'k', permissions: ['org.read'] }],
      [
        'post',
        `${base}/invitations`,
        { email: 'k@example.test', roleId: s.org.roles.MEMBER.publicId },
      ],
      [
        'post',
        `${base}/invite-links`,
        {
          roleId: s.org.roles.MEMBER.publicId,
          maxUses: 1,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
      [
        'post',
        `${base}/api-keys`,
        { name: 'k', permissions: ['org.read'], expiresInSec: 60 },
      ],
      [
        'post',
        `${base}/support-grants`,
        { staffUserId: s.A.authUserId, expiresInSec: 900, reason: 'x' },
      ],
      [
        'post',
        `${base}/ownership-transfers`,
        { toMemberId: s.a.memberPublicId, stepDownTo: null },
      ],
    ];
    for (const [method, url, body] of writes) {
      const agent = request(app.getHttpServer());
      const req =
        method === 'patch'
          ? agent.patch(url).set('if-match', '*')
          : agent.post(url).set('idempotency-key', `k-${url}`);
      const r = await req.set(HEADER, owner.token).send(body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
  });
});
