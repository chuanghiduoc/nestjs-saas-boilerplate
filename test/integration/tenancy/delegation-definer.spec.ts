import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  hashToken,
  newOrgApiKeyToken,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §6.14 (3D), §18.1 "Hàm definer": gọi bằng app_user KHÔNG có org context; tham số ngoài biên → lỗi. */
describe('3D definer functions', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });
  const find = (hex: string | null) =>
    withAppClient((c) =>
      c.query(
        `SELECT org_id::text, api_key_id::text, api_key_public_id::text FROM tenancy_find_org_api_key(decode($1, 'hex'))`,
        [hex],
      ),
    );

  it('tenancy_find_org_api_key: an active key → (org, id, public id); revoked, expired and unknown → empty; NULL or not 32 bytes → error', async () => {
    const live = await seedOrgApiKey(a, {
      createdByMemberId: a.owner.memberId,
      permissions: ['org.read'],
    });
    const revoked = await seedOrgApiKey(a, {
      createdByMemberId: a.owner.memberId,
      permissions: ['org.read'],
      revoked: true,
    });
    const expired = await seedOrgApiKey(a, {
      createdByMemberId: a.owner.memberId,
      permissions: ['org.read'],
      expiresInSec: -60,
    });
    expect((await find(hashToken(live.token))).rows).toEqual([
      {
        org_id: a.orgId,
        api_key_id: live.id,
        api_key_public_id: live.publicId,
      },
    ]);
    for (const k of [revoked, expired])
      expect((await find(hashToken(k.token))).rows).toEqual([]);
    expect((await find(hashToken(newOrgApiKeyToken()))).rows).toEqual([]);
    await expect(find(null)).rejects.toThrow(/must not be NULL/);
    await expect(find('ab'.repeat(31))).rejects.toThrow(/must be 32 bytes/);
  });
  it('tenancy_grantee_open_grant_orgs: every org with an unrevoked grant of the user (expired included), ordered; revoked ignored; NULL → error', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    await seedSupportGrant(a, {
      grantee: subject,
      grantedByMemberId: a.owner.memberId,
      permissions: ['org.read'],
      expiresInSec: -60,
    });
    const gb = await seedSupportGrant(b, {
      grantee: subject,
      grantedByMemberId: b.owner.memberId,
      permissions: ['org.read'],
    });
    const call = (id: string | null) =>
      withAppClient((c) =>
        c.query<{ org_id: string }>(
          `SELECT org_id::text FROM tenancy_grantee_open_grant_orgs($1)`,
          [id],
        ),
      );
    expect((await call(gb.granteeUserId)).rows.map((r) => r.org_id)).toEqual(
      [a.orgId, b.orgId].sort(),
    );
    await withAppClient((c) =>
      c
        .query(`SELECT set_config('app.org_id', $1, false)`, [b.orgId])
        .then(() =>
          c.query(
            `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`,
            [gb.id],
          ),
        ),
    );
    expect((await call(gb.granteeUserId)).rows.map((r) => r.org_id)).toEqual([
      a.orgId,
    ]);
    await expect(call(null)).rejects.toThrow(/must not be NULL/);
  });
  it('T2: dropping a 3D definer function as bare app_owner → 42501; under SET LOCAL ROLE tenancy_definer it would pass (rolled back)', async () => {
    await expect(
      ownerQuery(`DROP FUNCTION public.tenancy_find_org_api_key(bytea)`),
    ).rejects.toMatchObject({ code: '42501' });
    // `ownerQuery` gửi chuỗi nhiều câu qua simple protocol; lỗi ở bất kỳ câu nào làm lời gọi ném. ROLLBACK: không đổi gì.
    await ownerQuery(
      `BEGIN; SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.tenancy_grantee_open_grant_orgs(bigint); RESET ROLE; ROLLBACK;`,
    );
    expect(
      await ownerQuery(
        `SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'tenancy_grantee_open_grant_orgs'`,
      ),
    ).toHaveLength(1);
  });
});
