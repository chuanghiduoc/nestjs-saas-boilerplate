import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { TENANCY_TENANT_TABLES_3D } from '../../support/tenancy-catalog.js';
import {
  hashToken,
  inOrgTx,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 tiêu chí 1 cho bốn bảng 3D, bằng `app_user` qua kết nối thật (không qua RLS-bypass nào). */
describe('delegation tables are isolated by RLS (tiêu chí 1, phần 3D)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let keyB: { id: string };
  let grantB: { id: string };
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
    keyB = await seedOrgApiKey(b, {
      createdByMemberId: b.owner.memberId,
      permissions: ['org.read'],
    });
    grantB = await seedSupportGrant(b, {
      grantee: { externalSubject: `test:${v7()}` },
      grantedByMemberId: b.owner.memberId,
      permissions: ['org.read'],
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });
  const inA = <T>(fn: (c: import('pg').Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, a.orgId, () => fn(c)));

  it.each([...TENANCY_TENANT_TABLES_3D])(
    '%s: rows of org B are invisible, not updatable, not deletable from OrgScope(A)',
    async (t) => {
      expect(
        (
          await inA((c) =>
            c.query(`SELECT 1 FROM ${t} WHERE org_id = $1`, [b.orgId]),
          )
        ).rows,
      ).toEqual([]);
      // Bảng nối không có UPDATE nào (phạm vi bất biến): câu UPDATE bị từ chối ở quyền, trước cả RLS.
      const update = inA((c) =>
        c.query(`UPDATE ${t} SET updated_at = now() WHERE org_id = $1`, [
          b.orgId,
        ]),
      );
      if (t.endsWith('_permissions'))
        await expect(update).rejects.toMatchObject({ code: '42501' });
      else expect((await update).rowCount).toBe(0);
      expect(
        (
          await inA((c) =>
            c.query(`DELETE FROM ${t} WHERE org_id = $1`, [b.orgId]),
          )
        ).rowCount,
      ).toBe(0);
    },
  );
  it.each([...TENANCY_TENANT_TABLES_3D])(
    '%s: no org context → P0001',
    async (t) => {
      await expect(
        withAppClient((c) => c.query(`SELECT 1 FROM ${t}`)),
      ).rejects.toMatchObject({ code: 'P0001' });
    },
  );
  it('INSERT with org_id = B from OrgScope(A) → 42501; a bridge row pointing at a parent of org B → 23503', async () => {
    const t = newOrgApiKeyToken();
    await expect(
      inA((c) =>
        c.query(
          `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at) VALUES ($1, $2, 'x', decode($3, 'hex'), $4, now() + interval '1 day')`,
          [b.orgId, b.owner.memberId, hashToken(t), orgApiKeyHint(t)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inA((c) =>
        c.query(
          `INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`,
          [a.orgId, keyB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inA((c) =>
        c.query(
          `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`,
          [a.orgId, grantB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inA((c) =>
        c.query(
          `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at) VALUES ($1, $2, 'x', decode($3, 'hex'), $4, now() + interval '1 day')`,
          [a.orgId, b.owner.memberId, hashToken(t), orgApiKeyHint(t)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
