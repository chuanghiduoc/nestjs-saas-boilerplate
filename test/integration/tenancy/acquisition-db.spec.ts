import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLE_SET_C0,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §18.1 "Ràng buộc DB" phần 3C: mỗi CHECK/trigger/UNIQUE một ca bị từ chối, bằng app_user trong OrgScope. */
describe('acquisition DB constraints (spec SP3 §6.7–6.9, §18.1)', () => {
  let org: SeededOrg;
  const orgs: SeededOrg[] = [];
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)));
  const pendingInvite = (email: string, roleId = org.roles.MEMBER.id) =>
    inOrg((c) =>
      c.query(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, 'PENDING', decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '1 day')`,
        [org.orgId, email, roleId, org.owner.memberId],
      ),
    );
  beforeAll(async () => {
    org = await seedOrg();
    orgs.push(org);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
  });

  it('an invitation or a link carrying OWNER is refused by the trigger (S3-P5, B-16 at the DB)', async () => {
    await expect(
      pendingInvite('owner@example.test', org.roles.OWNER.id),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_role_not_owner',
    });
    await expect(
      seedInviteLink(org, {
        roleId: org.roles.OWNER.id,
        createdByMemberId: org.owner.memberId,
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_role_not_owner',
    });
  });
  it('the email must be canonical (lowercase, trimmed, NFC, ≤ 254)', async () => {
    for (const email of [
      'Ann@example.test',
      ' ann@example.test',
      `${'a'.repeat(250)}@x.test`,
      'á@example.test',
    ])
      await expect(pendingInvite(email)).rejects.toMatchObject({
        code: '23514',
        constraint: 'org_invitations_email_ck',
      });
  });
  it('T-4 at the DB: a second PENDING invitation for the same email is 23505 org_invitations_pending_email_uq; a finished one does not count', async () => {
    await seedInvitation(org, {
      email: 'dup@example.test',
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
      status: 'REVOKED',
    });
    await pendingInvite('dup@example.test');
    await expect(pendingInvite('dup@example.test')).rejects.toMatchObject({
      code: '23505',
      constraint: 'org_invitations_pending_email_uq',
    });
  });
  it('the token can only be cleared; a finished invitation cannot keep a token', async () => {
    const inv = await seedInvitation(org, {
      email: 'tok@example.test',
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    await expect(
      inOrg((c) =>
        c.query(
          `UPDATE org_invitations SET token_hash = decode(repeat('ff', 32), 'hex') WHERE id = $1`,
          [inv.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_token_clear_only',
    });
    await expect(
      inOrg((c) =>
        c.query(
          `UPDATE org_invitations SET status = 'REVOKED', resolved_at = now() WHERE id = $1`,
          [inv.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_pending_token_ck',
    });
    await inOrg((c) =>
      c.query(
        `UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now() WHERE id = $1`,
        [inv.id],
      ),
    );
  });
  it('use_count never exceeds max_uses and never decreases', async () => {
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 1,
    });
    await inOrg((c) =>
      c.query(`UPDATE org_invite_links SET use_count = 1 WHERE id = $1`, [
        link.id,
      ]),
    );
    await expect(
      inOrg((c) =>
        c.query(`UPDATE org_invite_links SET use_count = 2 WHERE id = $1`, [
          link.id,
        ]),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_use_count_ck',
    });
    await expect(
      inOrg((c) =>
        c.query(`UPDATE org_invite_links SET use_count = 0 WHERE id = $1`, [
          link.id,
        ]),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_use_count_monotonic',
    });
  });
  it('R-11 / R-18 at the DB: a PENDING invitation or an unrevoked link blocks the role delete; finished rows only lose role_id', async () => {
    const pendingRole = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'Pending holder',
    });
    await pendingInvite('r11@example.test', pendingRole.id);
    await expect(
      inOrg((c) =>
        c.query('DELETE FROM org_roles WHERE id = $1', [pendingRole.id]),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_pending_role_ck',
    });
    const linkRole = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'Link holder',
    });
    await seedInviteLink(org, {
      roleId: linkRole.id,
      createdByMemberId: org.owner.memberId,
      expiresInSec: -60,
    });
    await expect(
      inOrg((c) =>
        c.query('DELETE FROM org_roles WHERE id = $1', [linkRole.id]),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_active_role_ck',
    });
    const doneRole = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'Finished only',
    });
    const done = await seedInvitation(org, {
      email: 'r18@example.test',
      roleId: doneRole.id,
      inviterMemberId: org.owner.memberId,
      status: 'ACCEPTED',
    });
    await seedInviteLink(org, {
      roleId: doneRole.id,
      createdByMemberId: org.owner.memberId,
      revoked: true,
    });
    await inOrg((c) =>
      c.query('DELETE FROM org_roles WHERE id = $1', [doneRole.id]),
    );
    expect(
      (
        await inOrg((c) =>
          c.query(
            `SELECT org_id::text AS org_id, role_id FROM org_invitations WHERE id = $1`,
            [done.id],
          ),
        )
      ).rows,
    ).toEqual([{ org_id: org.orgId, role_id: null }]);
  });
  it('a member in a PENDING transfer cannot be deleted; one PENDING transfer per org; from ≠ to', async () => {
    const a = await seedMember(org, 'ADMIN');
    const b = await seedMember(org, 'MEMBER');
    await seedTransfer(org, {
      fromMemberId: org.owner.memberId,
      toMemberId: a.memberId,
    });
    await expect(
      seedTransfer(org, {
        fromMemberId: org.owner.memberId,
        toMemberId: b.memberId,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'org_ownership_transfers_pending_uq',
    });
    await expect(
      inOrg((c) =>
        c.query('DELETE FROM org_members WHERE id = $1', [a.memberId]),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_ownership_transfers_pending_members_ck',
    });
    await expect(
      seedTransfer(org, {
        fromMemberId: b.memberId,
        toMemberId: b.memberId,
        status: 'DECLINED',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_ownership_transfers_distinct_ck',
    });
  });
  it('deleting the organization while a directly anchored row remains fails loud (23001), never orphans', async () => {
    const other = await seedOrg();
    orgs.push(other);
    await seedInvitation(other, {
      email: 'orphan@example.test',
      roleId: other.roles.MEMBER.id,
      inviterMemberId: other.owner.memberId,
      status: 'REVOKED',
    });
    await expect(
      withAppClient((c) =>
        inOrgTx(c, other.orgId, async () => {
          await c.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = $1`,
            [other.orgId],
          );
          await c.query('DELETE FROM org_members WHERE org_id = $1', [
            other.orgId,
          ]);
          await c.query('DELETE FROM org_role_permissions WHERE org_id = $1', [
            other.orgId,
          ]);
          await c.query('DELETE FROM org_roles WHERE org_id = $1', [
            other.orgId,
          ]);
          await c.query('DELETE FROM organizations WHERE id = $1', [
            other.orgId,
          ]);
        }),
      ),
    ).rejects.toMatchObject({
      code: '23001',
      constraint: 'org_invitations_org_fk',
    });
  });
  it('an expiry not after creation is refused', async () => {
    await expect(
      inOrg((c) =>
        c.query(
          `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at) VALUES ($1, $2, $3, decode(repeat('ee', 32), 'hex'), 1, now())`,
          [org.orgId, org.roles.MEMBER.id, org.owner.memberId],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_expires_ck',
    });
  });
});
