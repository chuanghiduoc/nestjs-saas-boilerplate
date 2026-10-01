import type pg from 'pg';
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
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/**
 * Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng, không mất dữ liệu" áp cho 3C: bỏ ba bảng khi còn lời mời
 * đang chờ, link đang mở hoặc chuyển quyền đang chờ làm người đang cầm token/yêu cầu mất nó âm thầm. Dòng đã kết thúc
 * (lịch sử) không chặn: lịch sử bền nằm ở event outbox (SP6 audit). Database riêng, migrate tới đúng migration 3C.
 */
describe('down of …_acquisition refuses while an invitation, a link or a transfer is still open', () => {
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
    db = await createScratchDb('acqdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_acquisition'));
    if (at < 1) throw new Error('acquisition migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('an open invitation blocks the down; tables, rows and FORCE stay', async () => {
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES ($1, 'down@example.test', $2, $3, 'PENDING', decode($4, 'hex'), now() + interval '1 day')`,
        [org.orgId, org.roles.MEMBER.id, org.owner.memberId, '01'.repeat(32)],
      ),
    );
    await expect(down()).rejects.toThrow(
      /open invitations, invite links or ownership transfers exist/,
    );
    const owner = await db.client('owner');
    try {
      expect(
        (
          await owner.query(
            `SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('org_invitations', 'org_invite_links', 'org_ownership_transfers') ORDER BY relname`,
          )
        ).rows,
      ).toEqual([
        { relname: 'org_invitations', relforcerowsecurity: true },
        { relname: 'org_invite_links', relforcerowsecurity: true },
        { relname: 'org_ownership_transfers', relforcerowsecurity: true },
      ]);
    } finally {
      await owner.end();
    }
    expect(
      (await inOrg((c) => c.query(`SELECT 1 FROM org_invitations`))).rows,
    ).toHaveLength(1);
  });
  it('an open link and a pending transfer each block the down on their own', async () => {
    await inOrg((c) =>
      c.query(
        `UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now()`,
      ),
    );
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at)
         VALUES ($1, $2, $3, decode($4, 'hex'), 5, now() + interval '1 day')`,
        [org.orgId, org.roles.MEMBER.id, org.owner.memberId, '02'.repeat(32)],
      ),
    );
    await expect(down()).rejects.toThrow(
      /open invitations, invite links or ownership transfers exist/,
    );
    await inOrg((c) =>
      c.query(`UPDATE org_invite_links SET revoked_at = now()`),
    );
    const to = await seedMember(org, 'MEMBER');
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, status, expires_at) VALUES ($1, $2, $3, 'PENDING', now() + interval '1 day')`,
        [org.orgId, org.owner.memberId, to.memberId],
      ),
    );
    await expect(down()).rejects.toThrow(
      /open invitations, invite links or ownership transfers exist/,
    );
  });
  it('once nothing is open the down succeeds, dropping the tables, the trigger functions and the definer functions', async () => {
    await inOrg((c) =>
      c.query(
        `UPDATE org_ownership_transfers SET status = 'CANCELLED', resolved_at = now()`,
      ),
    );
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      const { rows } = await owner.query(
        `SELECT proname FROM pg_proc WHERE proname IN ('tenancy_find_invitation', 'tenancy_find_invite_link', 'tenancy_count_user_memberships',
           'tenancy_org_invitations_token_clear_only', 'tenancy_org_invitations_role_not_owner', 'tenancy_org_invite_links_role_not_owner',
           'tenancy_org_invite_links_use_count_monotonic', 'tenancy_org_invite_links_revoked_once',
           'tenancy_org_ownership_transfers_status_terminal')`,
      );
      expect(rows).toEqual([]);
      expect(
        (await owner.query(`SELECT to_regclass('public.org_invitations') AS t`))
          .rows,
      ).toEqual([{ t: null }]);
    } finally {
      await owner.end();
    }
  });
});
