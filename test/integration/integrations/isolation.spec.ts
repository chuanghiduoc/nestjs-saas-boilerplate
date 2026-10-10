import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  FAKE_SECRET_ENC,
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
  orgQuery,
  orphanDeliveries,
  type SeededEndpoint,
  type SeededMessage,
} from '../../support/integrations-seed.js';
import {
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Năm bảng tenant của 6C (spec SP6 tiêu chí 1). */
const TABLES = [
  'webhook_endpoints',
  'webhook_endpoint_secrets',
  'webhook_endpoint_event_types',
  'webhook_messages',
  'webhook_deliveries',
] as const;
/** Bảng mà `app_user` được UPDATE `updated_at` (messages và event_types không có grant UPDATE). */
const UPDATABLE = new Set<string>([
  'webhook_endpoints',
  'webhook_endpoint_secrets',
  'webhook_deliveries',
]);

describe('tenant isolation of the webhook tables (spec SP6 criterion 1, W-42)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let seededB: { endpoint: SeededEndpoint; message: SeededMessage };
  const countsOf = (orgId: string) =>
    inOrg(orgId, async (c) => {
      const out: Record<string, number> = {};
      for (const t of TABLES)
        out[t] =
          (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))
            .rows[0]?.n ?? -1;
      return out;
    });
  beforeAll(async () => {
    applyTestEnv();
    a = await seedOrg();
    b = await seedOrg();
    seededB = await inOrg(b.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, b.orgId);
      await c.query(
        `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`,
        [b.orgId, endpoint.id, FAKE_SECRET_ENC],
      );
      const message = await insertMessage(c, b.orgId);
      await insertDelivery(c, b.orgId, { endpoint, message });
      return { endpoint, message };
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  it.each(TABLES)(
    '%s: read, update and delete of org B from org A touch 0 rows',
    async (table) => {
      const before = await countsOf(b.orgId);
      expect(before[table]).toBeGreaterThan(0);
      await inOrg(a.orgId, async (c) => {
        expect(
          (await c.query(`SELECT 1 FROM ${table} WHERE org_id = $1`, [b.orgId]))
            .rowCount,
        ).toBe(0);
        if (UPDATABLE.has(table))
          expect(
            (
              await c.query(
                `UPDATE ${table} SET updated_at = now() WHERE org_id = $1`,
                [b.orgId],
              )
            ).rowCount,
          ).toBe(0);
        expect(
          (await c.query(`DELETE FROM ${table} WHERE org_id = $1`, [b.orgId]))
            .rowCount,
        ).toBe(0);
      });
      expect(await countsOf(b.orgId)).toEqual(before);
    },
  );
  it('an INSERT carrying org B from org A is refused by RLS (42501), on a plain and on a partitioned table', async () => {
    await expect(
      inOrg(a.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_endpoints (org_id, url) VALUES ($1, 'https://hooks.example.test/x')`,
          [b.orgId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inOrg(a.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body) VALUES ($1, $2, 'tenancy.org.updated', 1, '{}')`,
          [b.orgId, v7()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('without an org context every webhook table fails closed (P0001)', async () => {
    for (const t of TABLES)
      await expect(
        withAppClient((c) => c.query(`SELECT 1 FROM ${t}`)),
      ).rejects.toMatchObject({ code: 'P0001' });
  });
  it('the double FK refuses to attach org A rows to an endpoint or message of org B (23503)', async () => {
    await expect(
      inOrg(a.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`,
          [a.orgId, seededB.endpoint.id, FAKE_SECRET_ENC],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inOrg(a.orgId, async (c) =>
        insertDelivery(c, a.orgId, {
          endpoint: await insertEndpoint(c, a.orgId),
          message: seededB.message,
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('app_user cannot read a partition directly (42501)', async () => {
    const now = new Date();
    const partition = `webhook_deliveries_p${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(
      withAppClient((c) => c.query(`SELECT 1 FROM ${partition}`)),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('R-X33 invariant: every delivery has its endpoint, and the check really sees an orphan', async () => {
    expect(await orphanDeliveries(b.orgId)).toBe(0);
    // Không FK: một DELETE trần (không qua sweep) để lại delivery mồ côi — chứng minh câu kiểm không rỗng tình cờ, rồi dọn.
    const stray = await inOrg(b.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, b.orgId);
      const message = await insertMessage(c, b.orgId);
      const d = await insertDelivery(c, b.orgId, { endpoint, message });
      await c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [
        endpoint.id,
      ]);
      return d;
    });
    expect(await orphanDeliveries(b.orgId)).toBe(1);
    await orgQuery(
      b.orgId,
      `DELETE FROM webhook_deliveries WHERE public_id = $1`,
      [stray.publicId],
    );
    expect(await orphanDeliveries(b.orgId)).toBe(0);
  });
});
