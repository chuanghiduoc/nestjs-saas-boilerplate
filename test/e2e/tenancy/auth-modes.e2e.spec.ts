import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TEST_ORIGIN } from '../../support/auth-client.js';
import {
  FAKE_IDP_CLIENT_ID,
  FAKE_IDP_CLIENT_SECRET,
  startFakeIdp,
  type FakeIdp,
} from '../../support/fake-idp.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  purgeOrgs,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const TOKEN_TTL_SEC = 300;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('AUTH_MODE=external (spec SP3 §11, tiêu chí 13)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const created: string[] = [];
  const seeded: SeededOrg[] = [];
  const token = (sub: string, extra: Record<string, unknown> = {}) =>
    jwks.sign({
      iss: ISS,
      aud: AUD,
      sub,
      iat: nowSec(),
      exp: nowSec() + TOKEN_TTL_SEC,
      idtyp: 'user',
      ...extra,
    });
  const http = () => request(app.getHttpServer());
  beforeAll(async () => {
    jwks = await startFakeJwks();
    // Chỉ env của external đã có từ SP2: tenancy không đòi thêm biến nào (INT-I12).
    app = await startTenancyApp({
      extraImports: [ResilienceModule],
      env: {
        AUTH_MODE: 'external',
        BETTER_AUTH_SECRET: '',
        DB_AUTH_PASSWORD: '',
        AUTH_EXTERNAL_JWKS_URL: jwks.url,
        AUTH_EXTERNAL_ISSUER: ISS,
        AUTH_EXTERNAL_AUDIENCE: AUD,
        AUTH_EXTERNAL_ALGORITHMS: 'RS256',
        AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
        AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
        RESILIENCE_ALLOWED_SCHEMES: 'http,https',
        RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
        RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
      },
    });
  });
  afterAll(async () => {
    for (const o of seeded) await o.dispose();
    await purgeOrgs(created);
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('a fresh token (auth_time now) creates an org; the subject is stored as external_subject; email/name are null', async () => {
    const sub = `ext-${v7()}`;
    const t = await token(sub, { auth_time: nowSec() });
    const r = await http()
      .post('/v1/orgs')
      .set('authorization', `Bearer ${t}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'External' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect(
      await ownerQuery(
        'SELECT 1 FROM tenancy_users WHERE external_subject = $1',
        [sub],
      ),
    ).toHaveLength(1);
    const me = await http()
      .get(`/v1/orgs/${r.body.id}/members/me`)
      .set('authorization', `Bearer ${t}`);
    expect(me.body).toMatchObject({
      role: { systemKey: 'OWNER' },
      email: null,
      name: null,
    });
  });
  it('without auth_time: sensitive routes → 403 reauthentication_required (no iat fallback); narrowing leave still works', async () => {
    const org = await seedOrg({ owner: { externalSubject: `ext-${v7()}` } });
    seeded.push(org);
    const memberSub = `ext-${v7()}`;
    await seedMember(org, 'ADMIN', { externalSubject: memberSub });
    const t = await token(memberSub);
    const patch = await http()
      .patch(`/v1/orgs/${org.orgId}`)
      .set('authorization', `Bearer ${t}`)
      .set('if-match', '*')
      .send({ name: 'x' });
    expect([patch.status, patch.body.code]).toEqual([
      403,
      'reauthentication_required',
    ]);
    expect(
      (
        await http()
          .delete(`/v1/orgs/${org.orgId}/members/me`)
          .set('authorization', `Bearer ${t}`)
      ).status,
    ).toBe(204);
  });
  it('roles: a fresh token (auth_time) creates a custom role; without auth_time the same call → 403 reauthentication_required', async () => {
    const ownerSub = `ext-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: ownerSub } });
    seeded.push(org);
    const fresh = await token(ownerSub, { auth_time: nowSec() });
    const ok = await http()
      .post(`/v1/orgs/${org.orgId}/roles`)
      .set('authorization', `Bearer ${fresh}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'External role', permissions: ['org.read'] });
    expect([ok.status, ok.body.permissions]).toEqual([201, ['org.read']]);
    const stale = await token(ownerSub);
    const denied = await http()
      .post(`/v1/orgs/${org.orgId}/roles`)
      .set('authorization', `Bearer ${stale}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'No auth_time', permissions: ['org.read'] });
    expect([denied.status, denied.body.code]).toEqual([
      403,
      'reauthentication_required',
    ]);
  });
  it('K-11: an org key works on its org in external mode; U17: support grants are off (POST → 403 feature_disabled)', async () => {
    const sub = `ext-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: sub } });
    seeded.push(org);
    const key = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    expect(
      (await http().get(`/v1/orgs/${org.orgId}`).set('x-api-key', key.token))
        .status,
    ).toBe(200);
    const g = await http()
      .post(`/v1/orgs/${org.orgId}/support-grants`)
      .set(
        'authorization',
        `Bearer ${await token(sub, { auth_time: nowSec() })}`,
      )
      .set('idempotency-key', `k-${v7()}`)
      .send({ staffUserId: v7(), expiresInSec: 900, reason: 'x' });
    expect([g.status, g.body.code]).toEqual([403, 'feature_disabled']);
  });
});

describe('AUTH_MODE=hybrid (spec SP3 §11, tiêu chí 13)', () => {
  let app: INestApplication;
  let idp: FakeIdp;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  beforeAll(async () => {
    idp = await startFakeIdp({
      redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp`,
    });
    app = await startTenancyApp({
      env: {
        AUTH_MODE: 'hybrid',
        AUTH_OIDC_PROVIDER_ID: 'corp',
        AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
        AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
        AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
        AUTH_TRUSTED_PROVIDERS: 'corp',
      },
    });
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await idp?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a Better Auth session creates and reads an org; the subject is the auth user id', async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    const r = await authed(app, p)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Hybrid' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect((await authed(app, p).get(`/v1/orgs/${r.body.id}`)).status).toBe(
      200,
    );
    expect(
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        p.authUserId,
      ]),
    ).toHaveLength(1);
  });
});

describe('AUTH_MODE=hybrid delegations (spec SP3 §11 table: hybrid as local)', () => {
  let app: INestApplication;
  let idp: FakeIdp;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    idp = await startFakeIdp({
      redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp`,
    });
    app = await startTenancyApp({
      env: {
        AUTH_MODE: 'hybrid',
        AUTH_OIDC_PROVIDER_ID: 'corp',
        AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
        AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
        AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
        AUTH_TRUSTED_PROVIDERS: 'corp',
      },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await idp?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('an org key of a local owner reads its org (200); a stepped-up staff member with a grant reads it through SUPPORT_GRANT (200)', async () => {
    const O = await seedUserPrincipal();
    const staff = await seedStaffPrincipal();
    principals.push(O, staff);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const key = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/orgs/${org.orgId}`)
          .set('x-api-key', key.token)
      ).status,
    ).toBe(200);
    expect((await authed(app, staff).get(`/v1/orgs/${org.orgId}`)).status).toBe(
      404,
    );
    await seedSupportGrant(org, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: supportPresetKeys(
        app.get(PermissionCatalogueRegistry).merged(),
      ),
    });
    expect((await authed(app, staff).get(`/v1/orgs/${org.orgId}`)).status).toBe(
      200,
    );
  });
});
