import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  TENANCY_ONLY_CATALOGUE,
  apiKeyEligibleKeys,
  hashToken,
  inOrgTx,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RACE_ROUNDS = 50;
const FIXTURE_WRITE = 'zz_fixture.write';
/** Lỗi lúc COMMIT của trigger hoãn: `pg` ném ở câu COMMIT, `inOrgTx` ROLLBACK rồi ném lại. */
const commitFails = (p: Promise<unknown>, constraint: string) =>
  expect(p).rejects.toMatchObject({ code: '23514', constraint });

describe('delegation constraints at the database (spec SP3 §6.10–6.11, §18.1)', () => {
  let org: SeededOrg;
  let other: SeededOrg;
  const raceUsers: string[] = [];
  const sql = (o: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, o.orgId, () => c.query(q, params)));
  const keyRow = (
    o: SeededOrg,
    extra: Partial<{
      name: string;
      hint: string;
      hash: string;
      expires: string;
    }> = {},
  ) => {
    const t = newOrgApiKeyToken();
    return sql(
      o,
      `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5, ${extra.expires ?? "now() + interval '1 day'"}) RETURNING id::text`,
      [
        o.orgId,
        o.owner.memberId,
        extra.name ?? 'k',
        extra.hash ?? hashToken(t),
        extra.hint ?? orgApiKeyHint(t),
      ],
    );
  };
  beforeAll(async () => {
    org = await seedOrg();
    other = await seedOrg();
    // Quyền fixture "support_eligible nhưng không phải read" (catalogue không có): chỉ để chứng minh luật P-2 của trigger.
    await ownerQuery(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('zz_fixture', 'write', false, true, true) ON CONFLICT (key) DO NOTHING`,
    );
  });
  afterAll(async () => {
    await org?.dispose();
    await other?.dispose();
    await ownerQuery(`DELETE FROM tenancy_users WHERE id = ANY($1::bigint[])`, [
      raceUsers,
    ]);
    await ownerQuery(`DELETE FROM permissions WHERE key = $1`, [FIXTURE_WRITE]);
  });

  it('key name, hint, hash length and expiry are CHECKed; token_hash is unique', async () => {
    await expect(keyRow(org, { name: ' padded' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_api_keys_name_ck',
    });
    await expect(keyRow(org, { name: 'x'.repeat(65) })).rejects.toMatchObject({
      constraint: 'org_api_keys_name_ck',
    });
    await expect(keyRow(org, { hint: 'oak_abc' })).rejects.toMatchObject({
      constraint: 'org_api_keys_key_hint_ck',
    });
    await expect(keyRow(org, { hash: 'ab'.repeat(16) })).rejects.toMatchObject({
      constraint: 'org_api_keys_token_hash_ck',
    });
    await expect(
      keyRow(org, { expires: "now() - interval '1 second'" }),
    ).rejects.toMatchObject({ constraint: 'org_api_keys_expires_ck' });
    const k = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    await expect(
      keyRow(org, { hash: hashToken(k.token) }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'org_api_keys_token_hash_uq',
    });
  });
  it('key scope: only api-key-eligible, non-owner-only, non-deprecated permissions; closed under requires at COMMIT', async () => {
    await expect(
      seedOrgApiKey(org, {
        createdByMemberId: org.owner.memberId,
        permissions: ['org.read', 'org.update'],
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_api_key_permissions_guard',
    });
    await expect(
      seedOrgApiKey(org, {
        createdByMemberId: org.owner.memberId,
        permissions: ['org.read', 'org.delete'],
      }),
    ).rejects.toMatchObject({ constraint: 'org_api_key_permissions_guard' });
    // billing.read requires org.read (cả hai api-key-eligible): thiếu org.read → closure hoãn bắn lúc COMMIT.
    await commitFails(
      seedOrgApiKey(org, {
        createdByMemberId: org.owner.memberId,
        permissions: ['billing.read'],
      }),
      'org_api_key_permissions_closed_ck',
    );
    const full = apiKeyEligibleKeys(TENANCY_ONLY_CATALOGUE);
    await expect(
      seedOrgApiKey(org, {
        createdByMemberId: org.owner.memberId,
        permissions: full,
      }),
    ).resolves.toBeDefined();
  });
  it('grant scope: support-eligible READ permissions only (P-2); closed under requires at COMMIT', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    await expect(
      seedSupportGrant(org, {
        grantee: staff,
        grantedByMemberId: org.owner.memberId,
        permissions: ['org.read', 'billing.read'],
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_support_grant_permissions_guard',
    });
    await expect(
      seedSupportGrant(org, {
        grantee: staff,
        grantedByMemberId: org.owner.memberId,
        permissions: [FIXTURE_WRITE],
      }),
    ).rejects.toMatchObject({
      constraint: 'org_support_grant_permissions_guard',
    });
    await commitFails(
      seedSupportGrant(org, {
        grantee: staff,
        grantedByMemberId: org.owner.memberId,
        permissions: ['invitations.read'],
      }),
      'org_support_grant_permissions_closed_ck',
    );
    await expect(
      seedSupportGrant(org, {
        grantee: staff,
        grantedByMemberId: org.owner.memberId,
        permissions: supportPresetKeys(TENANCY_ONLY_CATALOGUE),
      }),
    ).resolves.toBeDefined();
  });
  it('one unrevoked grant per (org, grantee); a revoked one does not count', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    const preset = supportPresetKeys(TENANCY_ONLY_CATALOGUE);
    await seedSupportGrant(org, {
      grantee: staff,
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
      revoked: true,
    });
    await seedSupportGrant(org, {
      grantee: staff,
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
    });
    await expect(
      seedSupportGrant(org, {
        grantee: staff,
        grantedByMemberId: org.owner.memberId,
        permissions: preset,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'org_support_grants_active_uq',
    });
  });
  it('terminal states: a revoked key/grant stays revoked; first_used_at is written once', async () => {
    const k = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read'],
      revoked: true,
    });
    await expect(
      sql(org, `UPDATE org_api_keys SET revoked_at = NULL WHERE id = $1`, [
        k.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'org_api_keys_revoked_once' });
    const g = await seedSupportGrant(org, {
      grantee: { externalSubject: `test:${v7()}` },
      grantedByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    await sql(
      org,
      `UPDATE org_support_grants SET first_used_at = clock_timestamp() WHERE id = $1`,
      [g.id],
    );
    await expect(
      sql(
        org,
        `UPDATE org_support_grants SET first_used_at = clock_timestamp() WHERE id = $1`,
        [g.id],
      ),
    ).rejects.toMatchObject({
      constraint: 'org_support_grants_first_used_once',
    });
    await sql(
      org,
      `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`,
      [g.id],
    );
    await expect(
      sql(
        org,
        `UPDATE org_support_grants SET revoked_at = NULL WHERE id = $1`,
        [g.id],
      ),
    ).rejects.toMatchObject({ constraint: 'org_support_grants_revoked_once' });
  });
  it('removing the creator member cascades its keys and their scope (delegation never outlives the membership)', async () => {
    const m = await seedMember(org, 'ADMIN');
    const k = await seedOrgApiKey(org, {
      createdByMemberId: m.memberId,
      permissions: ['org.read'],
    });
    await sql(org, `DELETE FROM org_members WHERE id = $1`, [m.memberId]);
    expect(
      (await sql(org, `SELECT 1 FROM org_api_keys WHERE id = $1`, [k.id])).rows,
    ).toEqual([]);
    expect(
      (
        await sql(
          org,
          `SELECT 1 FROM org_api_key_permissions WHERE api_key_id = $1`,
          [k.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it('a grant for a member → 23514 org_support_grants_grantee_not_member at COMMIT; a member while a grant is open → 23514 org_members_no_active_support_grant; after revocation the member insert passes', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    await seedMember(org, 'MEMBER', subject);
    await commitFails(
      seedSupportGrant(org, {
        grantee: subject,
        grantedByMemberId: org.owner.memberId,
        permissions: ['org.read'],
      }),
      'org_support_grants_grantee_not_member',
    );
    const staff = { externalSubject: `test:${v7()}` };
    const g = await seedSupportGrant(org, {
      grantee: staff,
      grantedByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    await commitFails(
      seedMember(org, 'MEMBER', staff),
      'org_members_no_active_support_grant',
    );
    await sql(
      org,
      `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`,
      [g.id],
    );
    await expect(seedMember(org, 'MEMBER', staff)).resolves.toBeDefined();
  });
  it('the deferred triggers do not depend on app.org_id at COMMIT (definer + advisory lock): switching the org context before COMMIT still refuses', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    const member = await seedMember(org, 'MEMBER', subject);
    await expect(
      withAppClient(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [
            org.orgId,
          ]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at)
             VALUES ($1, $2, $3, 'ctx', now() + interval '1 day') RETURNING id::text`,
            [org.orgId, member.userId, org.owner.memberId],
          );
          await c.query(
            `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`,
            [org.orgId, rows[0]!.id],
          );
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [
            other.orgId,
          ]); // dưới FORCE RLS một trigger quyền caller sẽ mù ở đây
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_support_grants_grantee_not_member',
    });
  });
  it('REPEATABLE READ is refused by both deferred triggers (they rely on a fresh snapshot after the lock)', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    await expect(
      withAppClient(async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [
            org.orgId,
          ]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO tenancy_users (external_subject) VALUES ($1) RETURNING id::text`,
            [staff.externalSubject],
          );
          await c.query(
            `INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
            [org.orgId, rows[0]!.id, org.roles.MEMBER.id],
          );
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_members_no_active_support_grant',
    });
  });
  it(`X-12 / T-19: two direct SQL connections (no org lock) — one INSERT member, one INSERT grant for the same user — ×${RACE_ROUNDS} → exactly one commits`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const subject = `test:${v7()}`;
      const user = (
        await ownerQuery<{ id: string }>(
          `INSERT INTO tenancy_users (external_subject) VALUES ($1) RETURNING id::text`,
          [subject],
        )
      )[0]!.id;
      raceUsers.push(user);
      const asMember = withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(
            `INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
            [org.orgId, user, org.roles.MEMBER.id],
          ),
        ),
      );
      const asGrantee = withAppClient((c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at) VALUES ($1, $2, $3, 'race', now() + interval '1 day') RETURNING id::text`,
            [org.orgId, user, org.owner.memberId],
          );
          await c.query(
            `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`,
            [org.orgId, rows[0]!.id],
          );
        }),
      );
      const results = await Promise.allSettled([asMember, asGrantee]);
      expect(
        results.filter((r) => r.status === 'fulfilled'),
        `round ${i}`,
      ).toHaveLength(1);
      for (const r of results)
        if (r.status === 'rejected')
          expect(r.reason).toMatchObject({
            code: '23514',
            constraint: expect.stringMatching(
              /^(org_members_no_active_support_grant|org_support_grants_grantee_not_member)$/,
            ),
          });
    }
  }, 120_000);
  it('deleting the grantee tenancy user sets grantee_user_id NULL; deleting the granter member sets granted_by_member_id NULL', async () => {
    const staffSub = `test:${v7()}`;
    const g = await seedSupportGrant(org, {
      grantee: { externalSubject: staffSub },
      grantedByMemberId: org.owner.memberId,
      permissions: ['org.read'],
    });
    const owner2 = await seedMember(org, 'OWNER');
    const g2 = await seedSupportGrant(org, {
      grantee: { externalSubject: `test:${v7()}` },
      grantedByMemberId: owner2.memberId,
      permissions: ['org.read'],
    });
    await sql(
      org,
      `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`,
      [g.id],
    );
    await withAppClient((c) =>
      c.query(`DELETE FROM tenancy_users WHERE external_subject = $1`, [
        staffSub,
      ]),
    );
    await sql(org, `DELETE FROM org_members WHERE id = $1`, [owner2.memberId]);
    expect(
      (
        await sql(
          org,
          `SELECT id::text AS id, grantee_user_id, granted_by_member_id FROM org_support_grants WHERE id = ANY($1::bigint[]) ORDER BY id`,
          [[g.id, g2.id]],
        )
      ).rows,
    ).toEqual([
      {
        id: g.id,
        grantee_user_id: null,
        granted_by_member_id: org.owner.memberId,
      },
      {
        id: g2.id,
        grantee_user_id: g2.granteeUserId,
        granted_by_member_id: null,
      },
    ]);
  });
});
