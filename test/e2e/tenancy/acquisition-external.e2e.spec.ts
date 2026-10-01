import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { tokenFromMail } from '../../support/tenancy-acquisition.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const TOKEN_TTL_SEC = 300;
const nowSec = () => Math.floor(Date.now() / 1000);
const externalEnv = (jwks: FakeJwks): Record<string, string> => ({
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
});

describe('acquisition in AUTH_MODE=external with AUTH_EXTERNAL_EMAIL_CLAIM (spec SP3 §11, §13; tiêu chí 13)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const mail = mailpitFromInfra();
  const orgs: SeededOrg[] = [];
  const bearer = (sub: string, extra: Record<string, unknown> = {}) =>
    jwks.sign({
      iss: ISS,
      aud: AUD,
      sub,
      iat: nowSec(),
      exp: nowSec() + TOKEN_TTL_SEC,
      idtyp: 'user',
      auth_time: nowSec(),
      ...extra,
    });
  const as = async (sub: string, extra: Record<string, unknown> = {}) => {
    const t = await bearer(sub, extra);
    const agent = request(app.getHttpServer());
    return {
      post: (url: string, body: object) =>
        agent
          .post(url)
          .set('authorization', `Bearer ${t}`)
          .set('idempotency-key', `k-${v7()}`)
          .send(body),
      get: (url: string) => agent.get(url).set('authorization', `Bearer ${t}`),
    };
  };
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startTenancyApp({
      extraImports: [ResilienceModule],
      env: { ...externalEnv(jwks), AUTH_EXTERNAL_EMAIL_CLAIM: 'email' },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('invite (no inviter name) → mail → accept with a verified email claim of another case → 201; member email/name are null', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({
      owner: { externalSubject: owner },
      name: 'Ext Org',
    });
    orgs.push(org);
    const email = `ext-${v7()}@example.test`;
    const after = await mail.now();
    const created = await (
      await as(owner)
    ).post(`/v1/orgs/${org.orgId}/invitations`, {
      email,
      roleId: org.roles.MEMBER.publicId,
    });
    expect(created.status).toBe(201);
    const msg = await mail.waitFor(email, {
      subject: /You're invited to join Ext Org/,
      after,
    });
    expect(msg.Text).toContain('You are invited to join Ext Org as Member.');
    const token = await tokenFromMail(mail, email, /You're invited/, after);
    const invitee = `ext-i-${v7()}`;
    const accepted = await (
      await as(invitee, { email: email.toUpperCase(), email_verified: true })
    ).post('/v1/invitations/accept', { token });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ email: null, name: null });
  });
  it('an email claim that is not exactly verified (string "true", false, missing) → 403 email_not_verified and the invitation stays pending', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const email = `ext-nv-${v7()}@example.test`;
    const after = await mail.now();
    expect(
      (
        await (
          await as(owner)
        ).post(`/v1/orgs/${org.orgId}/invitations`, {
          email,
          roleId: org.roles.MEMBER.publicId,
        })
      ).status,
    ).toBe(201);
    const token = await tokenFromMail(mail, email, /You're invited/, after);
    for (const claims of [
      { email, email_verified: 'true' },
      { email, email_verified: false },
      { email_verified: true },
    ])
      expect(
        (
          await (
            await as(`ext-x-${v7()}`, claims)
          ).post('/v1/invitations/accept', { token })
        ).body.code,
        JSON.stringify(claims),
      ).toBe('email_not_verified');
    expect(
      (
        await withAppClient((c) =>
          inOrgTx(c, org.orgId, () =>
            c.query('SELECT status FROM org_invitations'),
          ),
        )
      ).rows,
    ).toEqual([{ status: 'PENDING' }]);
  });
  it('ownership transfer in external: no email is requested; the recipient finds it with GET ?status=PENDING and accepts', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const to = `ext-t-${v7()}`;
    const m = await seedMember(org, 'MEMBER', { externalSubject: to });
    const r = await (
      await as(owner)
    ).post(`/v1/orgs/${org.orgId}/ownership-transfers`, {
      toMemberId: m.memberPublicId,
    });
    expect(r.status).toBe(201);
    expect(
      await ownerQuery(
        'SELECT 1 FROM email_deliveries WHERE idempotency_key = $1',
        [`ownership-transfer-requested:${r.body.id}`],
      ),
    ).toEqual([]);
    const listed = await (
      await as(to)
    ).get(`/v1/orgs/${org.orgId}/ownership-transfers?status=PENDING`);
    expect(listed.body.data.map((t: { id: string }) => t.id)).toEqual([
      r.body.id,
    ]);
    expect(
      (
        await (
          await as(to)
        ).post(
          `/v1/orgs/${org.orgId}/ownership-transfers/${r.body.id}/accept`,
          {},
        )
      ).status,
    ).toBe(200);
  });
  it('invite links need no email claim: create → join with a plain external token → 201', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const link = await (
      await as(owner)
    ).post(`/v1/orgs/${org.orgId}/invite-links`, {
      roleId: org.roles.MEMBER.publicId,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(link.status).toBe(201);
    const token =
      /#token=([A-Za-z0-9_-]{43})$/.exec(String(link.body.url))?.[1] ?? '';
    expect(
      (
        await (
          await as(`ext-j-${v7()}`)
        ).post('/v1/invite-links/join', { token })
      ).status,
    ).toBe(201);
  });
});

describe('external without AUTH_EXTERNAL_EMAIL_CLAIM: email invitations auto-disable, nothing refuses to boot (INT-I12)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startTenancyApp({
      extraImports: [ResilienceModule],
      env: externalEnv(jwks),
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('POST invitations → 403 feature_disabled; invite links still work', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const t = await jwks.sign({
      iss: ISS,
      aud: AUD,
      sub: owner,
      iat: nowSec(),
      exp: nowSec() + TOKEN_TTL_SEC,
      idtyp: 'user',
      auth_time: nowSec(),
    });
    const http = () => request(app.getHttpServer());
    const inv = await http()
      .post(`/v1/orgs/${org.orgId}/invitations`)
      .set('authorization', `Bearer ${t}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({
        email: `x-${v7()}@example.test`,
        roleId: org.roles.MEMBER.publicId,
      });
    expect([inv.status, inv.body.code]).toEqual([403, 'feature_disabled']);
    const link = await http()
      .post(`/v1/orgs/${org.orgId}/invite-links`)
      .set('authorization', `Bearer ${t}`)
      .send({
        roleId: org.roles.MEMBER.publicId,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(link.status).toBe(201);
  });
});
