import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCipher } from '../../../src/core/security/index.js';
import { WebhookSecrets } from '../../../src/modules/integrations/application/webhook-secrets.js';
import { StandardWebhooksSigner } from '../../../src/modules/integrations/infra/standard-webhooks.signer.js';
import request from 'supertest';
import { TEST_ORIGIN } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  endpointsUrl,
  fixedResolver,
  startIntegrationsApp,
} from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const OVERLAP_SEC = 3600;
const STALE_SEC = 86_400;

describe('update, delete and rotate a webhook endpoint (spec SP6 §8.3, §7.3, §7.4)', () => {
  let app: INestApplication;
  let owner: SeededPrincipal;
  let stale: SeededPrincipal;
  let unverified: SeededPrincipal;
  let org: SeededOrg;
  const create = async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        url: 'https://hooks.example.test/x',
        eventTypes: ['tenancy.org.updated'],
      });
    expect(res.status).toBe(201);
    return { id: String(res.body.id), secret: String(res.body.secret) };
  };
  const one = (id: string) => `${endpointsUrl(org.orgId)}/${id}`;
  const destination = (id: string) => `${one(id)}/destination`;
  const eventsOf = (id: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM outbox_events WHERE org_id = $1 AND payload->>'endpointId' = $2 ORDER BY id`,
      [org.orgId, id],
    );
  /** Secret còn ký, giải mã bằng chính `WebhookSecrets` của app (thứ tự: hiện hành trước). */
  const signing = async (id: string) => {
    const rows = await orgQuery<{ public_id: string; secret_enc: string }>(
      org.orgId,
      `SELECT s.public_id::text, s.secret_enc FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.org_id = s.org_id AND e.id = s.endpoint_id
       WHERE e.public_id = $1 AND (s.expires_at IS NULL OR s.expires_at > now()) ORDER BY s.expires_at IS NULL DESC, s.created_at DESC`,
      [id],
    );
    const secrets = app.get(WebhookSecrets);
    return rows.map((r) =>
      secrets.open(r.secret_enc, {
        orgId: org.orgId,
        secretPublicId: r.public_id,
      }),
    );
  };
  beforeAll(async () => {
    app = await startIntegrationsApp({
      // Cho phép principal chưa xác thực email có session (mẫu K-15 của 3D), để thấy riêng 403 email_not_verified của route.
      env: {
        INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC: String(OVERLAP_SEC),
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      },
      resolver: fixedResolver({ 'private.example.test': ['10.0.0.7'] }),
    });
    owner = await seedUserPrincipal();
    stale = await seedUserPrincipal({ sessionAgeSec: STALE_SEC });
    unverified = await seedUserPrincipal({ emailVerified: false });
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'ADMIN', { authUserId: stale.authUserId });
    await seedMember(org, 'ADMIN', { authUserId: unverified.authUserId });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals([owner, stale, unverified]);
  });

  it('PATCH needs If-Match (428), a stale one is 412; url/eventTypes on the plain route are 422; /destination changes url and event types, the plain route the description; one updated event each, host only', async () => {
    const e = await create();
    expect(
      (await authed(app, owner).patch(one(e.id)).send({ description: 'x' }))
        .status,
    ).toBe(428);
    expect(
      (
        await authed(app, owner)
          .patch(one(e.id))
          .set('if-match', 'W/"9"')
          .send({ description: 'x' })
      ).status,
    ).toBe(412);
    const wrongRoute = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"1"')
      .send({ url: 'https://other.example.test/y' });
    expect([wrongRoute.status, wrongRoute.body.code]).toEqual([
      422,
      'validation_failed',
    ]);
    const dest = await authed(app, owner)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({
        url: 'https://other.example.test/y?k=v',
        eventTypes: ['tenancy.org.updated', 'tenancy.member.added'],
      });
    expect(dest.status).toBe(200);
    expect(dest.headers.etag).toBe('W/"2"');
    expect(dest.body).toMatchObject({
      url: 'https://other.example.test/y?k=v',
      eventTypes: ['tenancy.member.added', 'tenancy.org.updated'],
    });
    const desc = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"2"')
      .send({ description: 'Ops' });
    expect([desc.status, desc.headers.etag, desc.body.description]).toEqual([
      200,
      'W/"3"',
      'Ops',
    ]);
    expect(
      (await eventsOf(e.id))
        .filter((x) => x.type === 'integrations.endpoint.updated')
        .map((x) => x.payload),
    ).toEqual([
      {
        endpointId: e.id,
        changed: ['url', 'eventTypes'],
        urlHost: 'other.example.test',
        eventTypes: ['tenancy.member.added', 'tenancy.org.updated'],
      },
      { endpointId: e.id, changed: ['description'] },
    ]);
  });
  it('/destination to a private URL is 422 webhook_url_not_allowed and changes nothing; the same types in another order are a no-op (M3); description null clears it', async () => {
    const e = await create();
    const bad = await authed(app, owner)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({ url: 'https://private.example.test/x' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('webhook_url_not_allowed');
    const noop = await authed(app, owner)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({
        url: 'https://hooks.example.test/x',
        eventTypes: ['tenancy.org.updated', 'tenancy.org.updated'],
      });
    expect(noop.status).toBe(200);
    expect(noop.headers.etag).toBe('W/"1"');
    const cleared = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"1"')
      .send({ description: null });
    expect(cleared.body.description).toBeNull();
  });
  it('R-X34: /destination needs a fresh session — a stale ADMIN gets 403 reauthentication_required there, while the plain PATCH works', async () => {
    const e = await create();
    const refused = await authed(app, stale)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({ url: 'https://evil.example.test/x' });
    expect([refused.status, refused.body.code]).toEqual([
      403,
      'reauthentication_required',
    ]);
    const plain = await authed(app, stale)
      .patch(one(e.id))
      .set('if-match', 'W/"1"')
      .send({ description: 'still fine' });
    expect(plain.status).toBe(200);
    expect((await authed(app, owner).get(one(e.id))).body.url).toBe(
      'https://hooks.example.test/x',
    );
  });
  it('R-X34: /destination needs a verified email — an unverified ADMIN gets 403 email_not_verified there, while the plain PATCH works', async () => {
    const e = await create();
    const refused = await authed(app, unverified)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({ eventTypes: ['tenancy.member.added'] });
    expect([refused.status, refused.body.code]).toEqual([
      403,
      'email_not_verified',
    ]);
    expect(
      (
        await authed(app, unverified)
          .patch(one(e.id))
          .set('if-match', 'W/"1"')
          .send({ status: 'DISABLED' })
      ).status,
    ).toBe(200);
  });
  it('R-X34: a user API key never changes the destination (403 api_key_not_org_scoped on tenant routes; SessionOnly metadata is asserted in route-guards.spec)', async () => {
    const e = await create();
    const created = await request(app.getHttpServer())
      .post('/api/auth/api-key/create')
      .set('authorization', `Bearer ${owner.bearer}`)
      .set('origin', TEST_ORIGIN)
      .send({ name: 'r-x34' });
    expect(created.status).toBe(200);
    const refused = await request(app.getHttpServer())
      .patch(destination(e.id))
      .set('x-api-key', String(created.body.key))
      .set('origin', TEST_ORIGIN)
      .set('if-match', 'W/"1"')
      .send({ url: 'https://evil.example.test/x' });
    expect([refused.status, refused.body.code]).toEqual([
      403,
      'api_key_not_org_scoped',
    ]);
  });
  it('disable → DISABLED(MANUAL) + disabled event; enable → ACTIVE, failing_since cleared + enabled event; repeating a status is a no-op', async () => {
    const e = await create();
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE public_id = $1`,
      [e.id],
    );
    const off = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"1"')
      .send({ status: 'DISABLED' });
    expect(off.body).toMatchObject({
      status: 'DISABLED',
      disabledReason: 'MANUAL',
    });
    const again = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"2"')
      .send({ status: 'DISABLED' });
    expect(again.headers.etag).toBe('W/"2"');
    const on = await authed(app, owner)
      .patch(one(e.id))
      .set('if-match', 'W/"2"')
      .send({ status: 'ACTIVE' });
    expect(on.body).toMatchObject({
      status: 'ACTIVE',
      disabledReason: null,
      failingSince: null,
    });
    expect((await eventsOf(e.id)).map((x) => x.type)).toEqual([
      'integrations.endpoint.created',
      'integrations.endpoint.disabled',
      'integrations.endpoint.enabled',
    ]);
  });
  it('DELETE is a soft delete: 204, GET 404, purge_after = deleted_at + INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC, deleted event; a second DELETE is 404', async () => {
    const e = await create();
    expect((await authed(app, owner).delete(one(e.id))).status).toBe(204);
    expect((await authed(app, owner).get(one(e.id))).status).toBe(404);
    const [row] = await orgQuery<{ gap: number }>(
      org.orgId,
      `SELECT extract(epoch FROM purge_after - deleted_at)::int AS gap FROM webhook_endpoints WHERE public_id = $1`,
      [e.id],
    );
    expect(row?.gap).toBe(5_356_800);
    expect((await eventsOf(e.id)).map((x) => x.type)).toContain(
      'integrations.endpoint.deleted',
    );
    expect((await authed(app, owner).delete(one(e.id))).status).toBe(404);
  });
  it('rotate-secret: 200 { secret, previousExpiresAt = now + overlap }, no-store; both secrets sign and each verifies (W-2); secret_rotated event', async () => {
    const e = await create();
    const res = await authed(app, owner)
      .post(`${one(e.id)}/rotate-secret`)
      .send();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.secret).not.toBe(e.secret);
    const overlap =
      (Date.parse(res.body.previousExpiresAt) - Date.now()) / 1000;
    expect(overlap).toBeGreaterThan(OVERLAP_SEC - 60);
    expect(overlap).toBeLessThanOrEqual(OVERLAP_SEC);
    const live = await signing(e.id);
    expect(live).toEqual([res.body.secret, e.secret]);
    const at = new Date();
    const sig = new StandardWebhooksSigner().sign({
      secrets: live,
      messageId: 'evt',
      timestamp: at,
      body: '{}',
    });
    const headers = {
      'webhook-id': 'evt',
      'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
      'webhook-signature': sig,
    };
    for (const s of [e.secret, res.body.secret])
      expect(() => new Webhook(s).verify('{}', headers)).not.toThrow();
    expect((await eventsOf(e.id)).map((x) => x.type)).toContain(
      'integrations.endpoint.secret_rotated',
    );
  });
  it('M3: a rotation bumps the endpoint version — the aggregate version strictly increases, the old ETag is stale (412)', async () => {
    const e = await create();
    expect(
      (
        await authed(app, owner)
          .post(`${one(e.id)}/rotate-secret`)
          .send()
      ).status,
    ).toBe(200);
    const versions = await ownerQuery<{
      type: string;
      aggregate_version: number;
    }>(
      `SELECT type, aggregate_version::int AS aggregate_version FROM outbox_events WHERE org_id = $1 AND payload->>'endpointId' = $2 ORDER BY id`,
      [org.orgId, e.id],
    );
    expect(versions).toEqual([
      { type: 'integrations.endpoint.created', aggregate_version: 1 },
      { type: 'integrations.endpoint.secret_rotated', aggregate_version: 2 },
    ]);
    const get = await authed(app, owner).get(one(e.id));
    expect(get.headers.etag).toBe('W/"2"');
    expect(
      (
        await authed(app, owner)
          .patch(one(e.id))
          .set('if-match', 'W/"1"')
          .send({ description: 'x' })
      ).status,
    ).toBe(412);
    expect(
      (
        await authed(app, owner)
          .patch(one(e.id))
          .set('if-match', 'W/"2"')
          .send({ description: 'x' })
      ).status,
    ).toBe(200);
  });
  it('Review Focus 4: rotating twice within the overlap keeps exactly two signing secrets; the first stops verifying and is deleted on the next rotation', async () => {
    const e = await create();
    const r1 = await authed(app, owner)
      .post(`${one(e.id)}/rotate-secret`)
      .send();
    const r2 = await authed(app, owner)
      .post(`${one(e.id)}/rotate-secret`)
      .send();
    const live = await signing(e.id);
    expect(live).toEqual([r2.body.secret, r1.body.secret]);
    const at = new Date();
    const sig = new StandardWebhooksSigner().sign({
      secrets: live,
      messageId: 'evt',
      timestamp: at,
      body: '{}',
    });
    expect(sig.split(' ')).toHaveLength(2);
    const headers = {
      'webhook-id': 'evt',
      'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
      'webhook-signature': sig,
    };
    expect(() => new Webhook(e.secret).verify('{}', headers)).toThrow(
      /No matching signature/,
    );
    await authed(app, owner)
      .post(`${one(e.id)}/rotate-secret`)
      .send();
    const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(
      org.orgId,
      `SELECT count(*)::int AS n FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [e.id],
    );
    expect(n).toBe(3); // r3 hiện hành, r2 còn hạn, r1 hết hạn ngay ở lần xoay thứ ba; secret gốc đã bị xoá ở lần thứ ba
  });
  it('the secret ciphertext is unreadable with a FieldCipher of another keyring (sanity of the AAD binding at rest)', async () => {
    const e = await create();
    const [row] = await orgQuery<{ public_id: string; secret_enc: string }>(
      org.orgId,
      `SELECT s.public_id::text, s.secret_enc FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [e.id],
    );
    const foreign = new WebhookSecrets(
      new FieldCipher({ t1: Buffer.alloc(32, 7).toString('base64') }, 't1'),
    );
    expect(() =>
      foreign.open(row?.secret_enc ?? '', {
        orgId: org.orgId,
        secretPublicId: row?.public_id ?? '',
      }),
    ).toThrow();
  });
});
