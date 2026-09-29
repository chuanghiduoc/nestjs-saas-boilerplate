import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { v7 } from 'uuid';
import {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from '../../src/modules/tenancy/constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import { getInfra } from './infra.js';

/**
 * Thứ tự xoá cứng như job purge (3A Task 25 + SP4 §13.2): participant theo `order` (`core.scheduled-tasks` 0 = câu
 * `DELETE FROM scheduled_tasks` gọi riêng ở trên; `entitlements` 100) rồi bảng tenancy (1000). Plan sau chèn câu của
 * participant mình theo `order`.
 */
const PURGE_ORDER: readonly string[] = [
  ...ENTITLEMENTS_PURGE_STATEMENTS,
  ...ORG_PURGE_STATEMENTS,
];

export type SeedSubject = { authUserId: string } | { externalSubject: string };
export type SeededMember = {
  memberId: string;
  memberPublicId: string;
  userId: string;
  userPublicId: string;
  roleKey: SystemRoleKey;
};
type RoleRef = { id: string; publicId: string };
export type SeededOrg = {
  orgId: string;
  owner: SeededMember;
  roles: Record<SystemRoleKey, RoleRef>;
  dispose(): Promise<void>;
};
const PG_RESTRICT = '23001';
/**
 * Theo org đã seed: database của nó (để `seedMember` ghi đúng chỗ) và các dòng `tenancy_users` do helper tạo (dispose chỉ
 * xoá những dòng này).
 */
const seedStateOf = new WeakMap<
  SeededOrg,
  { database: string | undefined; createdUsers: string[] }
>();

/** Một client `app_user` thẳng Postgres: chỉ ở test/ (luật `not-to-test` chặn src import helper). */
export async function withAppClient<T>(
  fn: (c: pg.Client) => Promise<T>,
  database?: string,
): Promise<T> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: database ?? p.database,
    ...p.app,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Một transaction trong "OrgScope" (`set_config('app.org_id', …, true)`, đúng cách MikroORM áp session). */
export async function inOrgTx<T>(
  c: pg.Client,
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const out = await fn();
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

const subjectOf = (s: SeedSubject | undefined): SeedSubject =>
  s ?? { externalSubject: `test:${randomUUID()}` };

type IdRow = { id: string; public_id: string };

/** Upsert `tenancy_users` theo đúng cột của subject; `created` khi chính lần gọi này tạo dòng. */
async function upsertUser(
  c: pg.Client,
  s: SeedSubject,
): Promise<{ id: string; publicId: string; created: boolean }> {
  const byAuth = 'authUserId' in s;
  const value = byAuth ? s.authUserId : s.externalSubject;
  const inserted = byAuth
    ? await c.query<IdRow>(
        `INSERT INTO tenancy_users (auth_user_id) VALUES ($1) ON CONFLICT (auth_user_id) DO NOTHING RETURNING id::text, public_id::text`,
        [value],
      )
    : await c.query<IdRow>(
        `INSERT INTO tenancy_users (external_subject) VALUES ($1) ON CONFLICT (external_subject) DO NOTHING RETURNING id::text, public_id::text`,
        [value],
      );
  const existing = inserted.rows[0]
    ? undefined
    : byAuth
      ? await c.query<IdRow>(
          `SELECT id::text, public_id::text FROM tenancy_users WHERE auth_user_id = $1`,
          [value],
        )
      : await c.query<IdRow>(
          `SELECT id::text, public_id::text FROM tenancy_users WHERE external_subject = $1`,
          [value],
        );
  const row = inserted.rows[0] ?? existing?.rows[0];
  if (!row) throw new Error('seed: tenancy_users row vanished');
  return {
    id: row.id,
    publicId: row.public_id,
    created: inserted.rows.length === 1,
  };
}

async function insertMember(
  c: pg.Client,
  orgId: string,
  userId: string,
  roleId: string,
): Promise<IdRow> {
  const { rows } = await c.query<IdRow>(
    `INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING id::text, public_id::text`,
    [orgId, userId, roleId],
  );
  const row = rows[0];
  if (!row) throw new Error('seed: member insert returned no row');
  return row;
}

function isRestrictViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === PG_RESTRICT
  );
}

/**
 * Spec SP3 §5.3: MỘT transaction bằng `app_user` trong OrgScope(id): tenancy_users + organizations + 3 role hệ thống +
 * một member OWNER; trigger bootstrap đạt lúc COMMIT. Không cần `auth."user"` (subject mặc định `test:<uuid>`).
 * `dispose()` = MỘT transaction: xoá mềm (trigger role hệ thống cho xoá, trigger owner cuối miễn), xoá lịch, rồi
 * `ORG_PURGE_STATEMENTS` (đúng thứ tự của job purge); sau đó xoá từng dòng `tenancy_users` do helper tạo — `23001` nghĩa
 * là user còn là member ở org khác, giữ lại.
 */
export async function seedOrg(
  opts: { owner?: SeedSubject; name?: string; database?: string } = {},
): Promise<SeededOrg> {
  const orgId = v7();
  const createdUsers: string[] = [];
  const seeded = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const user = await upsertUser(c, subjectOf(opts.owner));
        if (user.created) createdUsers.push(user.id);
        await c.query(
          `INSERT INTO organizations (id, name, created_by_user_id) VALUES ($1, $2, $3)`,
          [orgId, opts.name ?? `Seed ${orgId.slice(-6)}`, user.id],
        );
        const { rows } = await c.query<IdRow & { system_key: string }>(
          `INSERT INTO org_roles (org_id, system_key) SELECT $1, k FROM unnest($2::text[]) AS k RETURNING id::text, public_id::text, system_key`,
          [orgId, SYSTEM_ROLE_KEYS],
        );
        const roleOf = (k: SystemRoleKey): RoleRef => {
          const r = rows.find((x) => x.system_key === k);
          if (!r) throw new Error(`seed: system role ${k} missing`);
          return { id: r.id, publicId: r.public_id };
        };
        const roles = {
          OWNER: roleOf('OWNER'),
          ADMIN: roleOf('ADMIN'),
          MEMBER: roleOf('MEMBER'),
        };
        const m = await insertMember(c, orgId, user.id, roles.OWNER.id);
        const owner: SeededMember = {
          memberId: m.id,
          memberPublicId: m.public_id,
          userId: user.id,
          userPublicId: user.publicId,
          roleKey: 'OWNER',
        };
        return { roles, owner };
      }),
    opts.database,
  );
  const org: SeededOrg = {
    orgId,
    ...seeded,
    dispose: () =>
      withAppClient(async (c) => {
        await inOrgTx(c, orgId, async () => {
          await c.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org() AND deleted_at IS NULL`,
          );
          await c.query(
            `DELETE FROM scheduled_tasks WHERE org_id = app_current_org()`,
          );
          for (const sql of PURGE_ORDER) await c.query(sql);
        });
        for (const id of createdUsers)
          await c
            .query(`DELETE FROM tenancy_users WHERE id = $1`, [id])
            .catch((err: unknown) => {
              if (!isRestrictViolation(err)) throw err;
            });
      }, opts.database),
  };
  seedStateOf.set(org, { database: opts.database, createdUsers });
  return org;
}

/** Thêm một member với role hệ thống vào org đã seed (một transaction trong OrgScope của org, cùng database với org). */
export async function seedMember(
  org: SeededOrg,
  roleKey: SystemRoleKey,
  subject?: SeedSubject,
): Promise<SeededMember> {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seedMember: org was not created by seedOrg');
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const user = await upsertUser(c, subjectOf(subject));
        if (user.created) state.createdUsers.push(user.id);
        const m = await insertMember(
          c,
          org.orgId,
          user.id,
          org.roles[roleKey].id,
        );
        return {
          memberId: m.id,
          memberPublicId: m.public_id,
          userId: user.id,
          userPublicId: user.publicId,
          roleKey,
        };
      }),
    state.database,
  );
}

/** Xoá cứng các org (không do `seedOrg` tạo) theo đúng `ORG_PURGE_STATEMENTS`; mỗi org một transaction trong OrgScope. */
export async function purgeOrgs(
  orgIds: readonly string[],
  database?: string,
): Promise<void> {
  await withAppClient(async (c) => {
    for (const orgId of orgIds)
      await inOrgTx(c, orgId, async () => {
        await c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org() AND deleted_at IS NULL`,
        );
        await c.query(
          'DELETE FROM scheduled_tasks WHERE org_id = app_current_org()',
        );
        for (const sql of PURGE_ORDER) await c.query(sql);
      });
  }, database);
}

/**
 * Dòng `tenancy_users` của các auth user (trước khi xoá `auth."user"`, FK RESTRICT). Gọi SAU `purgeOrgs`/`dispose()`:
 * không đọc `org_members` (RLS, ngoài OrgScope là lỗi), mà để FK `org_members_user_fk` quyết định — `23001` nghĩa là
 * user còn membership ở org khác chưa dọn: ném, test đỏ (không bao giờ để dòng mồ côi âm thầm).
 */
export async function deleteTenancyUsersOf(
  authUserIds: readonly string[],
): Promise<void> {
  await withAppClient((c) =>
    c.query('DELETE FROM tenancy_users WHERE auth_user_id = ANY($1::uuid[])', [
      authUserIds,
    ]),
  );
}

/** Mọi org đang tới hạn purge (hàm definer, không cần OrgScope): dọn sót của file trước để test đếm lô được. */
export async function dueOrgIds(database?: string): Promise<string[]> {
  return withAppClient(async (c) => {
    const { rows } = await c.query<{ org_id: string }>(
      `SELECT org_id::text AS org_id FROM tenancy_orgs_due_for_purge($1, $2)`,
      [PURGE_CURSOR_START, DEFINER_LIMIT_MAX],
    );
    return rows.map((r) => r.org_id);
  }, database);
}
