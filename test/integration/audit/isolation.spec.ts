import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  insertOrgAuditRow,
  insertPlatformAuditRow,
  monthTag,
  orgAuditRows,
  platformAuditRows,
} from '../../support/audit-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('audit_logs isolation under RLS (spec SP6 criterion 1, A-2)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    applyTestEnv();
    [a, b] = await Promise.all([seedOrg(), seedOrg()]);
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });
  it('a row of org A is visible to A and invisible to B', async () => {
    const eventId = v7();
    expect(
      await withAppClient((c) => insertOrgAuditRow(c, a.orgId, { eventId })),
    ).toBe(1);
    expect(await orgAuditRows(a.orgId, { eventId })).toHaveLength(1);
    expect(await orgAuditRows(b.orgId, { eventId })).toHaveLength(0);
  });
  it('inserting a row for org B inside org A is 42501', async () => {
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(
            `INSERT INTO audit_logs (org_id, event_id, action, action_version, occurred_at, actor_type, actor_id,
               target_type, target_id, correlation_id, data)
             VALUES ($1, $2, 'test.audit.row', 1, now(), 'system', 'test', 't', '1', 'c', '{}')`,
            [b.orgId, v7()],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('no org context is P0001', async () => {
    await expect(
      withAppClient((c) => c.query('SELECT 1 FROM audit_logs LIMIT 1')),
    ).rejects.toMatchObject({ code: 'P0001' });
  });
  it('app_user reading a partition directly is 42501 (org and platform)', async () => {
    const tag = monthTag(0).tag;
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(`SELECT 1 FROM audit_logs_p${tag} LIMIT 1`),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withAppClient((c) =>
        c.query(`SELECT 1 FROM platform_audit_logs_p${tag} LIMIT 1`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('platform rows need no org context', async () => {
    const eventId = v7();
    expect(
      await withAppClient((c) => insertPlatformAuditRow(c, { eventId })),
    ).toBe(1);
    expect(await platformAuditRows({ eventId })).toHaveLength(1);
  });
});
