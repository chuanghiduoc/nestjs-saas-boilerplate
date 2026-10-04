import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { v7 } from 'uuid';
import { ORG_API_KEY_PREFIX } from '../../src/modules/identity/ports/org-credential-authenticator.js';
import {
  DEFINER_LIMIT_MAX,
  KEY_HINT_LENGTH,
  ORG_API_KEY_SECRET_BYTES,
  PURGE_CURSOR_START,
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from '../../src/modules/tenancy/constants.js';
import {
  mergeCatalogues,
  type MergedCatalogue,
} from '../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../src/modules/tenancy/domain/tenancy-catalogue.js';

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

export type SeededRole = { id: string; publicId: string; name: string };
export type SeededCustomMember = Omit<SeededMember, 'roleKey'> & {
  roleId: string;
};
/**
 * Tập quyền của ma trận leo quyền (spec SP3 §18.3): C0 ⊊ C1; C2 có quyền C1 không có. C0, C2 là tập tường minh của spec
 * (không định nghĩa theo role hệ thống) nên là hằng; C1 và ADMIN định nghĩa theo role hệ thống nên TÍNH từ catalogue gộp
 * lúc chạy (R-X24): plan khác thêm quyền cho MEMBER/ADMIN (4A: `entitlements.read`) thì C1 vẫn trội MEMBER, V vẫn ≡ ADMIN.
 */
export const ROLE_SET_C0 = ['org.read'] as const;
export const ROLE_SET_C2 = [
  'org.read',
  'roles.read',
  'invitations.read',
] as const;
/** C1 = MEMBER ∪ {members.role.assign}, đã sắp. `merged` = `app.get(PermissionCatalogueRegistry).merged()` khi có app. */
export const roleSetC1 = (merged: MergedCatalogue): string[] =>
  [
    ...new Set([
      ...systemRolePermissions('MEMBER', merged),
      'members.role.assign',
    ]),
  ].sort();
/** `perms(ADMIN)` (tập của V, V′ ≡ ADMIN), đã sắp. */
export const adminKeys = (merged: MergedCatalogue): string[] =>
  [...systemRolePermissions('ADMIN', merged)].sort();
/** Catalogue của riêng tenancy: cho test không có app trong process (DB, process con). Mọi key của nó có dòng trong DB. */
export const TENANCY_ONLY_CATALOGUE: MergedCatalogue = mergeCatalogues([
  TENANCY_CATALOGUE,
]);

/** Role tuỳ biến trong org đã seed: MỘT transaction trong OrgScope; key lạ → không chèn đủ dòng → ném. */
export async function seedCustomRole(
  org: SeededOrg,
  o: { permissions: readonly string[]; name?: string },
): Promise<SeededRole> {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seedCustomRole: org was not created by seedOrg');
  const name = o.name ?? `Role ${randomUUID().slice(0, 8)}`;
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_roles (org_id, name) VALUES ($1, $2) RETURNING id::text, public_id::text`,
          [org.orgId, name],
        );
        const role = rows[0];
        if (!role)
          throw new Error('seedCustomRole: role insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, role.id, [...new Set(o.permissions)]],
        );
        if (inserted.rowCount !== new Set(o.permissions).size)
          throw new Error(
            `seedCustomRole: unknown permission in ${o.permissions.join(',')}`,
          );
        return { id: role.id, publicId: role.public_id, name };
      }),
    state.database,
  );
}

/** Thêm một member giữ role tuỳ biến đã seed (một transaction trong OrgScope, cùng database). */
export async function seedMemberInRole(
  org: SeededOrg,
  role: SeededRole,
  subject?: SeedSubject,
): Promise<SeededCustomMember> {
  const state = seedStateOf.get(org);
  if (!state)
    throw new Error('seedMemberInRole: org was not created by seedOrg');
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const user = await upsertUser(c, subjectOf(subject));
        if (user.created) state.createdUsers.push(user.id);
        const m = await insertMember(c, org.orgId, user.id, role.id);
        return {
          memberId: m.id,
          memberPublicId: m.public_id,
          userId: user.id,
          userPublicId: user.publicId,
          roleId: role.id,
        };
      }),
    state.database,
  );
}
const SEED_TOKEN_BYTES = 32;
const DEFAULT_SEED_TTL_SEC = 86_400;
/** Token như app sinh (`INVITE_TOKEN_BYTES` byte, base64url) và hash hex SHA-256 như `tokenHashHex` của domain. */
export const newToken = (): string =>
  randomBytes(SEED_TOKEN_BYTES).toString('base64url');
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export type SeededInvitation = { id: string; publicId: string; token: string };
export type SeededInviteLink = { id: string; publicId: string; token: string };
export type SeededTransfer = { id: string; publicId: string };

const databaseOf = (org: SeededOrg): string | undefined => {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seed: org was not created by seedOrg');
  return state.database;
};
/**
 * `created_at` = min(now, expires_at − 1 giờ): `CHECK (expires_at > created_at)` và `resolved_at >= created_at` đạt cả khi
 * `expiresInSec` âm (dòng đã hết hạn). Dòng không PENDING có `token_hash = NULL` và `resolved_at = now()` (CHECK §6.7).
 */
export async function seedInvitation(
  org: SeededOrg,
  o: {
    email: string;
    roleId: string;
    inviterMemberId: string | null;
    status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' | 'INVALIDATED';
    expiresInSec?: number;
  },
): Promise<SeededInvitation> {
  const token = newToken();
  const status = o.status ?? 'PENDING';
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at, resolved_at, created_at)
           SELECT $1, $2, $3, $4, $5, CASE WHEN $5 = 'PENDING' THEN decode($6, 'hex') END, e.at,
                  CASE WHEN $5 = 'PENDING' THEN NULL ELSE now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $7::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [
            org.orgId,
            o.email,
            o.roleId,
            o.inviterMemberId,
            status,
            hashToken(token),
            o.expiresInSec ?? DEFAULT_SEED_TTL_SEC,
          ],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedInvitation: insert returned no row');
  return { id: row.id, publicId: row.public_id, token };
}

export async function seedInviteLink(
  org: SeededOrg,
  o: {
    roleId: string;
    createdByMemberId: string | null;
    maxUses?: number;
    useCount?: number;
    expiresInSec?: number;
    revoked?: boolean;
  },
): Promise<SeededInviteLink> {
  const token = newToken();
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, use_count, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, decode($4, 'hex'), $5, $6, e.at, CASE WHEN $7 THEN now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $8::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [
            org.orgId,
            o.roleId,
            o.createdByMemberId,
            hashToken(token),
            o.maxUses ?? 5,
            o.useCount ?? 0,
            o.revoked ?? false,
            o.expiresInSec ?? DEFAULT_SEED_TTL_SEC,
          ],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedInviteLink: insert returned no row');
  return { id: row.id, publicId: row.public_id, token };
}

export async function seedTransfer(
  org: SeededOrg,
  o: {
    fromMemberId: string;
    toMemberId: string;
    stepDownTo?: 'ADMIN' | 'MEMBER' | null;
    status?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
    expiresInSec?: number;
  },
): Promise<SeededTransfer> {
  const status = o.status ?? 'PENDING';
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, step_down_to, status, expires_at, resolved_at, created_at)
           SELECT $1, $2, $3, $4, $5, e.at, CASE WHEN $5 = 'PENDING' THEN NULL ELSE now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $6::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [
            org.orgId,
            o.fromMemberId,
            o.toMemberId,
            o.stepDownTo ?? null,
            status,
            o.expiresInSec ?? DEFAULT_SEED_TTL_SEC,
          ],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedTransfer: insert returned no row');
  return { id: row.id, publicId: row.public_id };
}

/** Token như app sinh (`oak_` + base64url 32 byte) — chỉ test. */
export const newOrgApiKeyToken = (): string =>
  `${ORG_API_KEY_PREFIX}${randomBytes(ORG_API_KEY_SECRET_BYTES).toString('base64url')}`;
/** `key_hint` = `oak_` + 6 ký tự đầu phần ngẫu nhiên (`org_api_keys_key_hint_ck`). */
export const orgApiKeyHint = (token: string): string =>
  token.slice(0, ORG_API_KEY_PREFIX.length + KEY_HINT_LENGTH);
/** R-X24: tập quyền tính từ catalogue gộp, không viết cứng. */
export const apiKeyEligibleKeys = (merged: MergedCatalogue): string[] =>
  [...merged.values()]
    .filter((e) => e.apiKeyEligible && !e.ownerOnly && !e.deprecated)
    .map((e) => e.key)
    .sort();
export const supportPresetKeys = (merged: MergedCatalogue): string[] =>
  [...merged.values()]
    .filter(
      (e) =>
        e.supportEligible &&
        e.action === 'read' &&
        !e.ownerOnly &&
        !e.deprecated,
    )
    .map((e) => e.key)
    .sort();

export type SeededOrgApiKey = { id: string; publicId: string; token: string };
/** Một transaction trong OrgScope; phạm vi chèn theo key (key lạ → không đủ dòng → ném). `created_at` lùi như lời mời. */
export async function seedOrgApiKey(
  org: SeededOrg,
  o: {
    createdByMemberId: string;
    permissions: readonly string[];
    name?: string;
    expiresInSec?: number;
    revoked?: boolean;
  },
): Promise<SeededOrgApiKey> {
  const token = newOrgApiKeyToken();
  const keys = [...new Set(o.permissions)];
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, decode($4, 'hex'), $5, e.at, CASE WHEN $6 THEN LEAST(now(), e.at - interval '1 hour') END,
                  LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $7::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [
            org.orgId,
            o.createdByMemberId,
            o.name ?? 'seed key',
            hashToken(token),
            orgApiKeyHint(token),
            o.revoked ?? false,
            o.expiresInSec ?? DEFAULT_SEED_TTL_SEC,
          ],
        );
        const key = rows[0];
        if (!key) throw new Error('seedOrgApiKey: insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, key.id, keys],
        );
        if (inserted.rowCount !== keys.length)
          throw new Error(
            `seedOrgApiKey: unknown permission in ${keys.join(',')}`,
          );
        return key;
      }),
    databaseOf(org),
  );
  return { id: row.id, publicId: row.public_id, token };
}

export type SeededSupportGrant = {
  id: string;
  publicId: string;
  granteeUserId: string | null;
};
/** Upsert `tenancy_users` của người nhận trong cùng transaction; dòng mới được `dispose()` dọn. */
export async function seedSupportGrant(
  org: SeededOrg,
  o: {
    grantee: SeedSubject | null;
    grantedByMemberId: string | null;
    permissions: readonly string[];
    reason?: string;
    expiresInSec?: number;
    revoked?: boolean;
  },
): Promise<SeededSupportGrant> {
  const state = seedStateOf.get(org);
  if (!state)
    throw new Error('seedSupportGrant: org was not created by seedOrg');
  const keys = [...new Set(o.permissions)];
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        let granteeUserId: string | null = null;
        if (o.grantee) {
          const user = await upsertUser(c, o.grantee);
          if (user.created) state.createdUsers.push(user.id);
          granteeUserId = user.id;
        }
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, $4, e.at, CASE WHEN $5 THEN LEAST(now(), e.at - interval '1 hour') END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $6::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [
            org.orgId,
            granteeUserId,
            o.grantedByMemberId,
            o.reason ?? 'SUP-SEED',
            o.revoked ?? false,
            o.expiresInSec ?? DEFAULT_SEED_TTL_SEC,
          ],
        );
        const grant = rows[0];
        if (!grant) throw new Error('seedSupportGrant: insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, grant.id, keys],
        );
        if (inserted.rowCount !== keys.length)
          throw new Error(
            `seedSupportGrant: unknown permission in ${keys.join(',')}`,
          );
        return { id: grant.id, publicId: grant.public_id, granteeUserId };
      }),
    state.database,
  );
}
