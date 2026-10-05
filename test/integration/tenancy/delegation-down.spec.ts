import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng": bỏ bốn bảng khi còn key/grant đang dùng được là xoá credential âm thầm. */
describe('down of …_delegation refuses while a key or a grant is still usable', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let org: SeededOrg;
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: previous });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('delegdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_delegation'));
    if (at < 1) throw new Error('delegation migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('an active key blocks; then an active grant blocks; once both are revoked the down drops tables, triggers and functions', async () => {
    const k = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    await expect(down()).rejects.toThrow(
      /unrevoked organization API keys or support grants exist/,
    );
    await inOrg((c) =>
      c.query(
        `UPDATE org_api_keys SET revoked_at = clock_timestamp() WHERE id = $1`,
        [k.id],
      ),
    );
    const g = await seedSupportGrant(org, {
      grantee: { externalSubject: `test:${v7()}` },
      grantedByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    await expect(down()).rejects.toThrow(
      /unrevoked organization API keys or support grants exist/,
    );
    await inOrg((c) =>
      c.query(
        `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`,
        [g.id],
      ),
    );
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      expect(
        (
          await owner.query(
            `SELECT proname FROM pg_proc WHERE proname LIKE 'tenancy\\_%' AND (proname LIKE '%org\\_api\\_key%' OR proname LIKE '%support\\_grant%' OR proname = 'tenancy_grantee_open_grant_orgs')`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner.query(
            `SELECT tgname FROM pg_trigger WHERE tgname = 'org_members_no_active_support_grant'`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner.query(
            `SELECT proname FROM pg_proc WHERE proname = 'tenancy_permission_scope_closed_ck'`,
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await owner.end();
    }
  });
});
