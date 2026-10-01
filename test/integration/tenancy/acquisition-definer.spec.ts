import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hashToken,
  inOrgTx,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §6.14, §18.1 "Hàm definer" phần 3C: gọi bằng app_user KHÔNG có org context. */
describe('3C definer functions (spec SP3 §6.14)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  const call = <T extends object>(sql: string, params: unknown[]) =>
    withAppClient(async (c) => (await c.query<T>(sql, params)).rows);
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  it('tenancy_find_invitation returns (org, id) of a PENDING invitation only', async () => {
    const pending = await seedInvitation(a, {
      email: 'p@example.test',
      roleId: a.roles.MEMBER.id,
      inviterMemberId: a.owner.memberId,
    });
    expect(
      await call(
        `SELECT org_id::text AS org_id, invitation_id::text AS id FROM tenancy_find_invitation(decode($1, 'hex'))`,
        [hashToken(pending.token)],
      ),
    ).toEqual([{ org_id: a.orgId, id: pending.id }]);
    await withAppClient((c) =>
      inOrgTx(c, a.orgId, () =>
        c.query(
          `UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now() WHERE id = $1`,
          [pending.id],
        ),
      ),
    );
    expect(
      await call(`SELECT * FROM tenancy_find_invitation(decode($1, 'hex'))`, [
        hashToken(pending.token),
      ]),
    ).toEqual([]);
    expect(
      await call(`SELECT * FROM tenancy_find_invitation(decode($1, 'hex'))`, [
        hashToken('unknown'),
      ]),
    ).toEqual([]);
  });
  it('tenancy_find_invite_link returns unrevoked links (expiry and uses are checked later under the org lock)', async () => {
    const expired = await seedInviteLink(b, {
      roleId: b.roles.MEMBER.id,
      createdByMemberId: b.owner.memberId,
      expiresInSec: -60,
    });
    const revoked = await seedInviteLink(b, {
      roleId: b.roles.MEMBER.id,
      createdByMemberId: b.owner.memberId,
      revoked: true,
    });
    expect(
      await call(
        `SELECT org_id::text AS org_id, invite_link_id::text AS id FROM tenancy_find_invite_link(decode($1, 'hex'))`,
        [hashToken(expired.token)],
      ),
    ).toEqual([{ org_id: b.orgId, id: expired.id }]);
    expect(
      await call(`SELECT * FROM tenancy_find_invite_link(decode($1, 'hex'))`, [
        hashToken(revoked.token),
      ]),
    ).toEqual([]);
  });
  it('tenancy_count_user_memberships counts every membership, soft-deleted orgs included (M7)', async () => {
    const m = await seedMember(a, 'MEMBER');
    await seedMember(b, 'MEMBER', {
      externalSubject: await subjectOf(m.userId),
    });
    await withAppClient((c) =>
      inOrgTx(c, a.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
          [a.orgId],
        ),
      ),
    );
    expect(
      await call(`SELECT tenancy_count_user_memberships($1)::int AS n`, [
        m.userId,
      ]),
    ).toEqual([{ n: 2 }]);
    await withAppClient((c) =>
      inOrgTx(c, a.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = NULL, purge_after = NULL WHERE id = $1`,
          [a.orgId],
        ),
      ),
    );
  });
  it.each<[string, string, unknown[]]>([
    [
      'find_invitation: NULL',
      'SELECT * FROM tenancy_find_invitation($1)',
      [null],
    ],
    [
      'find_invitation: 31 bytes',
      `SELECT * FROM tenancy_find_invitation(decode(repeat('aa', 31), 'hex'))`,
      [],
    ],
    [
      'find_invite_link: NULL',
      'SELECT * FROM tenancy_find_invite_link($1)',
      [null],
    ],
    [
      'find_invite_link: 33 bytes',
      `SELECT * FROM tenancy_find_invite_link(decode(repeat('aa', 33), 'hex'))`,
      [],
    ],
    [
      'count_user_memberships: NULL',
      'SELECT tenancy_count_user_memberships($1)',
      [null],
    ],
  ])('%s raises (DB-M3)', async (_name, sql, params) => {
    await expect(call(sql, params)).rejects.toThrow(
      /must (not be NULL|be 32 bytes)/,
    );
  });
});

/** `external_subject` của dòng `tenancy_users` (bảng global): để seedMember ở org B dùng lại đúng user đó. */
async function subjectOf(userId: string): Promise<string> {
  const rows = await withAppClient(
    async (c) =>
      (
        await c.query<{ s: string }>(
          'SELECT external_subject AS s FROM tenancy_users WHERE id = $1',
          [userId],
        )
      ).rows,
  );
  const s = rows[0]?.s;
  if (!s) throw new Error('seeded member without an external subject');
  return s;
}
