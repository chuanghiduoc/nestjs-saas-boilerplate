import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import { TEST_ORIGIN } from '../../support/auth-client.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FAKE_IDP_CLIENT_ID,
  FAKE_IDP_CLIENT_SECRET,
  startFakeIdp,
  type FakeIdp,
} from '../../support/fake-idp.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const TOKEN_TTL_SEC = 300;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('AUTH_MODE=external: an org created with an external token is provisioned and readable (spec SP4 §20.3)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const created: string[] = [];
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startEntitlementsApp(examplePlans, {
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
    await purgeOrgs(created);
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });
  it('POST /v1/orgs then GET …/entitlements → the default plan, no new env needed', async () => {
    const t = await jwks.sign({
      iss: ISS,
      aud: AUD,
      sub: `ext-${v7()}`,
      iat: nowSec(),
      exp: nowSec() + TOKEN_TTL_SEC,
      idtyp: 'user',
      auth_time: nowSec(),
    });
    const http = () => request(app.getHttpServer());
    const r = await http()
      .post('/v1/orgs')
      .set('authorization', `Bearer ${t}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'External' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    const e = await http()
      .get(`/v1/orgs/${r.body.id}/entitlements`)
      .set('authorization', `Bearer ${t}`);
    expect([e.status, e.body.plan.key]).toEqual([200, 'free']);
  });
});

describe('AUTH_MODE=hybrid: the same with a Better Auth session', () => {
  let app: INestApplication;
  let idp: FakeIdp;
  let p: SeededPrincipal;
  const created: string[] = [];
  beforeAll(async () => {
    // Env tối thiểu của hybrid, chép từ `test/e2e/tenancy/auth-modes.e2e.spec.ts` (3A): hybrid đòi provider OIDC.
    idp = await startFakeIdp({
      redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp`,
    });
    app = await startEntitlementsApp(examplePlans, {
      env: {
        AUTH_MODE: 'hybrid',
        AUTH_OIDC_PROVIDER_ID: 'corp',
        AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
        AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
        AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
        AUTH_TRUSTED_PROVIDERS: 'corp',
      },
    });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await purgeOrgs(created);
    if (p) await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await idp?.close();
    if (p) await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });
  it('POST /v1/orgs then GET …/entitlements → the default plan', async () => {
    const r = await authed(app, p)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Hybrid' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    const e = await authed(app, p).get(`/v1/orgs/${r.body.id}/entitlements`);
    expect([e.status, e.body.plan.key]).toEqual([200, 'free']);
  });
});
