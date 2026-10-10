import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  endpointsUrl,
  fixedResolver,
  startIntegrationsApp,
} from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
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

const LIMIT = 3;
const TYPES_CAP = 2;
const STALE_SEC = 86_400;
const body = (url = `https://hooks.example.test/${Math.random()}`) => ({
  url,
  eventTypes: ['tenancy.org.updated', 'tenancy.org.updated'],
});

describe('create, list and read webhook endpoints (spec SP6 §8.3, §9.2, R6-26)', () => {
  let app: INestApplication;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let stale: SeededPrincipal;
  let org: SeededOrg;
  const people: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startIntegrationsApp({
      // M7: env chỉ hạ trần lúc chạy; schema/OpenAPI giữ WEBHOOK_EVENT_TYPES_MAX (test unit `schemas.spec.ts`).
      env: {
        INTEGRATIONS_MAX_ENDPOINTS_PER_ORG: String(LIMIT),
        INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT: String(TYPES_CAP),
      },
      resolver: fixedResolver({ 'private.example.test': ['10.0.0.5'] }),
    });
    owner = await seedUserPrincipal();
    member = await seedUserPrincipal();
    stale = await seedUserPrincipal({ sessionAgeSec: STALE_SEC });
    people.push(owner, member, stale);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await seedMember(org, 'ADMIN', { authUserId: stale.authUserId });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(people);
  });

  it('201 + Location + ETag; the secret comes once, no-store; event types are deduplicated; one audited created event with only the host', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        ...body('https://hooks.example.test/a?token=t'),
        description: 'Main',
      });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(
      `${endpointsUrl(org.orgId)}/${res.body.id}`,
    );
    expect(res.headers.etag).toBe('W/"1"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      url: 'https://hooks.example.test/a?token=t',
      description: 'Main',
      eventTypes: ['tenancy.org.updated'],
      status: 'ACTIVE',
      disabledReason: null,
      failingSince: null,
    });
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const [secretRow] = await orgQuery<{
      secret_enc: string;
      expires_at: Date | null;
    }>(
      org.orgId,
      `SELECT s.secret_enc, s.expires_at FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [res.body.id],
    );
    expect(secretRow?.secret_enc).toMatch(/^v1\./);
    expect(secretRow?.secret_enc).not.toContain(
      String(res.body.secret).slice('whsec_'.length),
    );
    expect(secretRow?.expires_at).toBeNull();
    const events = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.endpoint.created' AND payload->>'endpointId' = $2`,
      [org.orgId, res.body.id],
    );
    expect(events.map((e) => e.payload)).toEqual([
      {
        endpointId: res.body.id,
        urlHost: 'hooks.example.test',
        eventTypes: ['tenancy.org.updated'],
      },
    ]);
    const get = await authed(app, owner).get(
      `${endpointsUrl(org.orgId)}/${res.body.id}`,
    );
    expect(get.status).toBe(200);
    expect(get.headers.etag).toBe('W/"1"');
    expect(get.body).not.toHaveProperty('secret');
  });
  it.each([
    ['a private address', 'https://private.example.test/x'],
    ['a loopback literal', 'https://127.0.0.1/x'],
    ['http in a https-only setup', 'http://hooks.example.test/x'],
  ])(
    '422 webhook_url_not_allowed for %s, with a generic detail and no IP',
    async (_name, url) => {
      const res = await authed(app, owner)
        .post(endpointsUrl(org.orgId))
        .send(body(url));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('webhook_url_not_allowed');
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    },
  );
  it('422 webhook_event_type_unknown names the unknown type under errors; a type that is not a webhook event is unknown too', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        url: 'https://hooks.example.test/u',
        eventTypes: ['tenancy.org.created'],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('webhook_event_type_unknown');
    expect(res.body.errors).toEqual([
      expect.objectContaining({
        path: 'eventTypes',
        code: 'tenancy.org.created',
      }),
    ]);
  });
  it('M7: more distinct event types than INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT is 422 validation_failed on eventTypes; duplicates do not count', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        url: 'https://hooks.example.test/cap',
        eventTypes: [
          'tenancy.org.updated',
          'tenancy.member.added',
          'tenancy.member.removed',
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual([
      expect.objectContaining({ path: 'eventTypes' }),
    ]);
  });
  it('M3: event types come back in byte order, the same order the DB aggregates with COLLATE "C"', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        url: 'https://hooks.example.test/order',
        eventTypes: ['tenancy.org.updated', 'tenancy.member.added'],
      });
    expect(res.status).toBe(201);
    expect(res.body.eventTypes).toEqual([
      'tenancy.member.added',
      'tenancy.org.updated',
    ]);
    expect(
      (
        await authed(app, owner).get(
          `${endpointsUrl(org.orgId)}/${res.body.id}`,
        )
      ).body.eventTypes,
    ).toEqual(res.body.eventTypes);
  });
  it('a member without webhooks.write gets 403; a stale session gets 403 reauthentication_required', async () => {
    expect(
      (await authed(app, member).post(endpointsUrl(org.orgId)).send(body()))
        .status,
    ).toBe(403);
    const res = await authed(app, stale)
      .post(endpointsUrl(org.orgId))
      .send(body());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauthentication_required');
  });
  it('R6-26: LIMIT + 2 creations queued on the org lock give exactly the remaining slots, the rest 422 webhook_endpoints_limit', async () => {
    const [{ n: before } = { n: 0 }] = await orgQuery<{ n: number }>(
      org.orgId,
      `SELECT count(*)::int AS n FROM webhook_endpoints WHERE deleted_at IS NULL`,
    );
    const tries = LIMIT - before + 2;
    const results = await raceOnOrgLock(org.orgId, tries, () =>
      Promise.all(
        Array.from({ length: tries }, () =>
          authed(app, owner).post(endpointsUrl(org.orgId)).send(body()),
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMIT - before);
    expect(statuses.filter((s) => s === 422)).toHaveLength(2);
    for (const r of results.filter((x) => x.status === 422))
      expect(r.body.code).toBe('webhook_endpoints_limit');
    const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(
      org.orgId,
      `SELECT count(*)::int AS n FROM webhook_endpoints WHERE deleted_at IS NULL`,
    );
    expect(n).toBe(LIMIT);
  });
  it('list is offset-paginated, oldest first, without secrets; an unknown or malformed id is 404', async () => {
    const res = await authed(app, member).get(
      `${endpointsUrl(org.orgId)}?page=1&pageSize=2`,
    );
    expect(res.status).toBe(403); // MEMBER không có webhooks.read (grantTo.member = false)
    const own = await authed(app, owner).get(
      `${endpointsUrl(org.orgId)}?page=1&pageSize=2`,
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      page: 1,
      pageSize: 2,
      totalCount: LIMIT,
      hasMore: true,
    });
    expect(own.body.data).toHaveLength(2);
    for (const e of own.body.data) expect(e).not.toHaveProperty('secret');
    expect(
      (await authed(app, owner).get(`${endpointsUrl(org.orgId)}/not-a-uuid`))
        .status,
    ).toBe(404);
    expect(
      (
        await authed(app, owner).get(
          `${endpointsUrl(org.orgId)}/0199a000-0000-7000-8000-000000000000`,
        )
      ).status,
    ).toBe(404);
  });
  it('GET /v1/webhook-event-types lists the code catalogue with the JSON Schema of each payload, for any signed-in user', async () => {
    const res = await authed(app, member).get('/v1/webhook-event-types');
    expect(res.status).toBe(200);
    const types = res.body.data.map(
      (d: { type: string; version: number }) => `${d.type}@${d.version}`,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'tenancy.org.updated@1',
        'tenancy.member.added@1',
      ]),
    );
    const updated = res.body.data.find(
      (d: { type: string }) => d.type === 'tenancy.org.updated',
    );
    expect(updated.schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['orgId', 'changed']),
    });
  });
});
