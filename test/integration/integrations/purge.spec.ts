import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, pgFields } from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { OrgPurgeParticipantRegistry } from '../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import {
  FAKE_SECRET_ENC,
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
  orgQuery,
} from '../../support/integrations-seed.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const TABLES = [
  'webhook_deliveries',
  'webhook_messages',
  'webhook_endpoint_event_types',
  'webhook_endpoint_secrets',
  'webhook_endpoints',
];
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
const makeDue = (orgId: string) =>
  orgQuery(
    orgId,
    `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
    [orgId],
  );
const seedWebhookRows = (orgId: string) =>
  inOrg(orgId, async (c) => {
    const endpoint = await insertEndpoint(c, orgId);
    await c.query(
      `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`,
      [orgId, endpoint.id, FAKE_SECRET_ENC],
    );
    await insertDelivery(c, orgId, {
      endpoint,
      message: await insertMessage(c, orgId),
    });
  });
const countsOf = async (orgId: string) => {
  const out: Record<string, number> = {};
  for (const t of TABLES)
    out[t] =
      (
        await orgQuery<{ n: number }>(
          orgId,
          `SELECT count(*)::int AS n FROM ${t}`,
        )
      )[0]?.n ?? -1;
  return out;
};

describe('org purge participant integrations (spec SP6 §8.3 "Xoá cứng org", R-X5, W-41)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    app = await createTestApp(integrationsCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
  });

  it('registered at order 120 between the other participants and tenancy core', () => {
    const order = app
      .get(OrgPurgeParticipantRegistry)
      .participants()
      .map((p) => [p.key, p.order] as const);
    expect(order).toContainEqual(['integrations', 120]);
  });
  it('a purge removes every webhook row of that org, both partitioned tables included, child before parent; another org keeps its rows', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    await seedWebhookRows(a.orgId);
    await seedWebhookRows(b.orgId);
    await makeDue(a.orgId);
    expect(
      await app
        .get(OrgScope)
        .run(a.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(a.orgId))),
    ).toBe('purged');
    expect(Object.values(await countsOf(a.orgId))).toEqual([0, 0, 0, 0, 0]);
    expect(Object.values(await countsOf(b.orgId)).every((n) => n > 0)).toBe(
      true,
    );
  });
});

describe('without the integrations participant a purge fails loud (23001), nothing removed', () => {
  let app: INestApplication;
  let o: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    o = await seedOrg();
    await seedWebhookRows(o.orgId);
    await makeDue(o.orgId);
  });
  afterAll(async () => {
    await o?.dispose();
    await app?.close();
  });
  it('organizations delete hits FK RESTRICT from webhook_endpoints', async () => {
    const err: unknown = await app
      .get(OrgScope)
      .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
      .catch((e: unknown) => e);
    expect(pgFields(err)?.sqlState).toBe('23001');
    expect((await countsOf(o.orgId)).webhook_endpoints).toBe(1);
  });
});
