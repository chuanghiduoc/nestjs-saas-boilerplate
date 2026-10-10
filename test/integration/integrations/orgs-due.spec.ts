import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURGE_CURSOR_START } from '../../../src/core/sweep/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
} from '../../support/integrations-seed.js';
import {
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const GRACE_SEC = 60;
const due = (after: string, limit: number, grace: number) =>
  withAppClient((c) =>
    c.query<{ org_id: string }>(
      'SELECT org_id FROM integrations_orgs_due(p_after => $1::uuid, p_limit => $2::integer, p_grace_sec => $3::integer)',
      [after, limit, grace],
    ),
  );

describe('integrations_orgs_due (spec SP6 §6.8, R-X14)', () => {
  const orgs: SeededOrg[] = [];
  const mine = new Map<string, string>();
  const orgOf = (label: string): string => {
    const id = mine.get(label);
    if (id === undefined) throw new Error(`no org seeded for ${label}`);
    return id;
  };
  const seedWith = async (
    label: string,
    fn: (c: pg.Client, orgId: string) => Promise<void>,
  ) => {
    const o = await seedOrg();
    orgs.push(o);
    mine.set(label, o.orgId);
    await inOrg(o.orgId, (c) => fn(c, o.orgId));
  };
  const delivery = async (c: pg.Client, orgId: string) => {
    const endpoint = await insertEndpoint(c, orgId);
    return insertDelivery(c, orgId, {
      endpoint,
      message: await insertMessage(c, orgId),
    });
  };
  beforeAll(async () => {
    applyTestEnv();
    await seedWith('overdue', async (c, id) => {
      const d = await delivery(c, id);
      await c.query(
        `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 hour' WHERE public_id = $1`,
        [d.publicId],
      );
    });
    await seedWith('leased', async (c, id) => {
      const d = await delivery(c, id);
      await c.query(
        `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 1, lease_until = now() - interval '1 hour' WHERE public_id = $1`,
        [d.publicId],
      );
    });
    await seedWith('purgeable', async (c, id) => {
      const e = await insertEndpoint(c, id);
      await c.query(
        `UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
        [e.id],
      );
    });
    await seedWith('fresh', async (c, id) => {
      await delivery(c, id);
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
  });

  it('returns orgs with overdue work, expired leases or endpoints due for hard delete, ascending, distinct; not the fresh one', async () => {
    const got = (await due(PURGE_CURSOR_START, 1000, GRACE_SEC)).rows.map(
      (r) => r.org_id,
    );
    const ours = got.filter((id) => [...mine.values()].includes(id));
    expect(ours).toEqual(
      [orgOf('overdue'), orgOf('leased'), orgOf('purgeable')].sort(),
    );
    expect(ours).not.toContain(orgOf('fresh'));
    expect([...got].sort()).toEqual(got);
    expect(new Set(got).size).toBe(got.length);
  });
  it('keyset: p_after skips earlier orgs and p_limit caps the batch', async () => {
    const first = (await due(PURGE_CURSOR_START, 1, GRACE_SEC)).rows;
    expect(first).toHaveLength(1);
    const after = first[0]?.org_id ?? PURGE_CURSOR_START;
    expect(
      (await due(after, 1000, GRACE_SEC)).rows.map((r) => r.org_id),
    ).not.toContain(after);
  });
  it.each([
    [0, GRACE_SEC, /p_limit must be between 1 and 1000/],
    [1001, GRACE_SEC, /p_limit must be between 1 and 1000/],
    [10, 0, /p_grace_sec must be between 1 and 86400/],
    [10, 86_401, /p_grace_sec must be between 1 and 86400/],
  ])('refuses p_limit %i / p_grace_sec %i', async (limit, grace, re) => {
    await expect(due(PURGE_CURSOR_START, limit, grace)).rejects.toThrow(re);
  });
});
