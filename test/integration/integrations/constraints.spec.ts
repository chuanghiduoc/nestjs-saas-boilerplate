import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  FAKE_SECRET_ENC,
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
} from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const ep = (o: SeededOrg) => inOrg(o.orgId, (c) => insertEndpoint(c, o.orgId));
const delivery = (o: SeededOrg) =>
  inOrg(o.orgId, async (c) => {
    const endpoint = await insertEndpoint(c, o.orgId);
    const message = await insertMessage(c, o.orgId);
    return {
      endpoint,
      message,
      ...(await insertDelivery(c, o.orgId, { endpoint, message })),
    };
  });

describe('webhook schema invariants live in the DB (spec SP6 §6.5)', () => {
  let org: SeededOrg;
  beforeAll(async () => {
    applyTestEnv();
    org = await seedOrg();
  });
  afterAll(async () => org?.dispose());

  it('the event type catalogue holds the six tenancy webhook events', async () => {
    const rows = await ownerQuery<{ type: string }>(
      `SELECT type FROM webhook_event_types WHERE type LIKE 'tenancy.%' ORDER BY type`,
    );
    expect(rows.map((r) => r.type)).toEqual([
      'tenancy.member.added',
      'tenancy.member.removed',
      'tenancy.member.role_changed',
      'tenancy.org.deleted',
      'tenancy.org.restored',
      'tenancy.org.updated',
    ]);
  });
  it.each([
    ['a url that is not http(s)', 'ftp://files.example.test/x', 'ACTIVE', null],
    ['a url shorter than 10 characters', 'https://a', 'ACTIVE', null],
    [
      'DISABLED without a reason',
      'https://hooks.example.test/x',
      'DISABLED',
      null,
    ],
    [
      'a reason while ACTIVE',
      'https://hooks.example.test/x',
      'ACTIVE',
      'MANUAL',
    ],
    ['an unknown status', 'https://hooks.example.test/x', 'PAUSED', null],
  ] as const)(
    'endpoint CHECK refuses %s (23514)',
    async (_name, url, status, reason) => {
      await expect(
        inOrg(org.orgId, (c) =>
          c.query(
            `INSERT INTO webhook_endpoints (org_id, url, status, disabled_reason) VALUES ($1, $2, $3, $4)`,
            [org.orgId, url, status, reason],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );
  it('deleted_at and purge_after come together, and purge_after is after deleted_at', async () => {
    const e = await ep(org);
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(
          `UPDATE webhook_endpoints SET deleted_at = now() WHERE id = $1`,
          [e.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_endpoints_deleted_pair_ck',
    });
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(
          `UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() - interval '1 second' WHERE id = $1`,
          [e.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_endpoints_purge_after_ck',
    });
  });
  it('at most one current secret per endpoint; a plaintext secret is refused', async () => {
    const e = await ep(org);
    const insert = (enc: string, expired: boolean) =>
      inOrg(org.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc, expires_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)`,
          [org.orgId, e.id, enc, expired],
        ),
      );
    await insert(FAKE_SECRET_ENC, false);
    await expect(insert(FAKE_SECRET_ENC, false)).rejects.toMatchObject({
      code: '23505',
      constraint: 'webhook_endpoint_secrets_current_uq',
    });
    await expect(insert('whsec_plain', true)).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_endpoint_secrets_enc_ck',
    });
  });
  it('an unknown event type cannot be subscribed (FK to webhook_event_types)', async () => {
    const e = await inOrg(org.orgId, (c) =>
      insertEndpoint(c, org.orgId, { eventTypes: [] }),
    );
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type) VALUES ($1, $2, 'tenancy.org.created')`,
          [org.orgId, e.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'webhook_endpoint_event_types_type_fk',
    });
  });
  it('message body over 262144 bytes and an event type outside the pattern are refused; webhook.test is accepted', async () => {
    await expect(
      inOrg(org.orgId, (c) =>
        insertMessage(c, org.orgId, { body: 'x'.repeat(262_145) }),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_messages_body_ck',
    });
    await expect(
      inOrg(org.orgId, (c) =>
        insertMessage(c, org.orgId, { eventType: 'Bad Type' }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inOrg(org.orgId, (c) =>
        insertMessage(c, org.orgId, { eventType: 'webhook.test' }),
      ),
    ).resolves.toBeDefined();
  });
  it.each([
    [
      'SENDING without a lease',
      `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL WHERE public_id = $1`,
    ],
    [
      'PENDING without next_attempt_at',
      `UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE public_id = $1`,
    ],
    [
      'SUCCEEDED without completed_at',
      `UPDATE webhook_deliveries SET status = 'SUCCEEDED', next_attempt_at = NULL WHERE public_id = $1`,
    ],
    [
      'cycle_base above attempts_total',
      `UPDATE webhook_deliveries SET cycle_base = attempts_total + 1 WHERE public_id = $1`,
    ],
    [
      'an unknown last_error',
      `UPDATE webhook_deliveries SET last_error = 'OOPS' WHERE public_id = $1`,
    ],
    [
      'a negative local_failures',
      `UPDATE webhook_deliveries SET local_failures = -1 WHERE public_id = $1`,
    ],
    [
      'a status code of 99',
      `UPDATE webhook_deliveries SET last_status_code = 99 WHERE public_id = $1`,
    ],
  ])('delivery CHECK refuses %s (23514)', async (_name, sql) => {
    const d = await delivery(org);
    await expect(
      inOrg(org.orgId, (c) => c.query(sql, [d.publicId])),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('a delivery carries the created_at of its message (FK includes created_at)', async () => {
    await expect(
      inOrg(org.orgId, async (c) => {
        const endpoint = await insertEndpoint(c, org.orgId);
        const message = await insertMessage(c, org.orgId);
        const shifted = {
          id: message.id,
          createdAt: new Date(
            Date.parse(message.createdAt) + 1000,
          ).toISOString(),
        };
        return insertDelivery(c, org.orgId, { endpoint, message: shifted });
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'webhook_deliveries_message_fk',
    });
  });
  it('one delivery per (message, endpoint)', async () => {
    const d = await delivery(org);
    const err = await inOrg(org.orgId, (c) =>
      insertDelivery(c, org.orgId, {
        endpoint: d.endpoint,
        message: d.message,
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof pg.DatabaseError))
      throw new Error(
        'expected a duplicate delivery to be refused by the database',
      );
    expect(err.code).toBe('23505');
    // Trên bảng partitioned, lỗi mang tên ràng buộc của partition (Postgres tự đặt); cha của nó phải là ràng buộc khai ở bảng cha.
    const parents = await ownerQuery<{ parent: string }>(
      `SELECT p.conname AS parent FROM pg_constraint k JOIN pg_constraint p ON p.oid = k.conparentid WHERE k.conname = $1`,
      [err.constraint],
    );
    expect(parents).toEqual([
      { parent: 'webhook_deliveries_message_endpoint_uq' },
    ]);
  });
  it('SECRET_UNAVAILABLE is an accepted last_error (R-X35 local failure)', async () => {
    const d = await delivery(org);
    const r = await inOrg(org.orgId, (c) =>
      c.query(
        `UPDATE webhook_deliveries SET last_error = 'SECRET_UNAVAILABLE', local_failures = 1 WHERE public_id = $1`,
        [d.publicId],
      ),
    );
    expect(r.rowCount).toBe(1);
  });
  it('seeds webhooks.read (apiKey, support) and webhooks.write (requires read, neither apiKey nor support)', async () => {
    const rows = await ownerQuery(
      `SELECT p.key, p.owner_only, p.api_key_eligible, p.support_eligible,
         coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM permission_requires q JOIN permissions r ON r.id = q.required_permission_id
                   WHERE q.permission_id = p.id), '{}') AS requires
       FROM permissions p WHERE p.key IN ('webhooks.read', 'webhooks.write') ORDER BY p.key`,
    );
    expect(rows).toEqual([
      {
        key: 'webhooks.read',
        owner_only: false,
        api_key_eligible: true,
        support_eligible: true,
        requires: [],
      },
      {
        key: 'webhooks.write',
        owner_only: false,
        api_key_eligible: false,
        support_eligible: false,
        requires: ['webhooks.read'],
      },
    ]);
  });
});
