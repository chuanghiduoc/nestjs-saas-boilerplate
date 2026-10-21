import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../src/modules/audit/constants.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  asPartitionOwner,
  insertPlatformAuditRow,
  monthTag,
  platformAuditRows,
} from '../../support/audit-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('audit tables are append-only (spec SP6 §6.4, A-3, T11)', () => {
  let org: SeededOrg;
  beforeAll(async () => {
    applyTestEnv();
    org = await seedOrg();
  });
  afterAll(() => org?.dispose());
  it.each([
    'UPDATE audit_logs SET action = action',
    'DELETE FROM audit_logs',
    'TRUNCATE audit_logs',
  ])('app_user cannot run %s (42501)', async (stmt) => {
    await expect(
      withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(stmt))),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it.each([
    'UPDATE platform_audit_logs SET action = action',
    'DELETE FROM platform_audit_logs',
    'TRUNCATE platform_audit_logs',
  ])('app_user cannot run %s (42501)', async (stmt) => {
    await expect(withAppClient((c) => c.query(stmt))).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('the owner updating or deleting through the parent is stopped by the trigger', async () => {
    const eventId = v7();
    await withAppClient((c) => insertPlatformAuditRow(c, { eventId }));
    for (const stmt of [
      `UPDATE public.platform_audit_logs SET action = 'x.y.z' WHERE event_id = '${eventId}'`,
      `DELETE FROM public.platform_audit_logs WHERE event_id = '${eventId}'`,
    ])
      await expect(asPartitionOwner([stmt])).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('append-only'),
      });
    expect(await platformAuditRows({ eventId })).toHaveLength(1);
  });
  it('the owner truncating either parent is stopped by the statement trigger', async () => {
    for (const t of AUDIT_TABLES)
      await expect(
        asPartitionOwner([`TRUNCATE public.${t}`]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining(
          'drop expired partitions instead of TRUNCATE',
        ),
      });
  });
  it('the trigger fires on a partition addressed directly by the owner (row triggers are cloned, spike P1)', async () => {
    const eventId = v7();
    await withAppClient((c) => insertPlatformAuditRow(c, { eventId }));
    await expect(
      asPartitionOwner([
        `DELETE FROM public.platform_audit_logs_p${monthTag(0).tag} WHERE event_id = '${eventId}'`,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await platformAuditRows({ eventId })).toHaveLength(1);
  });
});
