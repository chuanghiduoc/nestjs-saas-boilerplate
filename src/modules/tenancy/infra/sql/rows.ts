import { z } from 'zod';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';

/** Kiểm dòng DB ở ranh giới (bigint đọc dạng text; không bao giờ `Number` hoá id). */
const text = z.string();
const nullableText = z.string().nullable();
const date = z.coerce.date();
const nullableDate = z.coerce.date().nullable();
const systemKey = z.enum(SYSTEM_ROLE_KEYS).nullable();

export const OrgRowSchema = z
  .object({
    id: text,
    name: text,
    version: z.coerce.number().int(),
    deleted_at: nullableDate,
    purge_after: nullableDate,
    created_by_user_id: nullableText,
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    deletedAt: r.deleted_at,
    purgeAfter: r.purge_after,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export const ORG_COLUMNS =
  'id::text AS id, name, version, deleted_at, purge_after, created_by_user_id::text AS created_by_user_id, created_at, updated_at';

export const RoleRowSchema = z
  .object({
    id: text,
    public_id: text,
    system_key: systemKey,
    name: nullableText,
    description: nullableText,
    version: z.coerce.number().int(),
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    publicId: r.public_id,
    systemKey: r.system_key,
    name: r.name,
    description: r.description,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export const ROLE_COLUMNS =
  'id::text AS id, public_id::text AS public_id, system_key, name, description, version, created_at, updated_at';

export const MemberRowSchema = z
  .object({
    id: text,
    public_id: text,
    user_id: text,
    user_public_id: text,
    auth_user_id: nullableText,
    external_subject: nullableText,
    role_id: text,
    role_public_id: text,
    system_key: systemKey,
    role_name: nullableText,
    version: z.coerce.number().int(),
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    publicId: r.public_id,
    userId: r.user_id,
    userPublicId: r.user_public_id,
    authUserId: r.auth_user_id,
    externalSubject: r.external_subject,
    roleId: r.role_id,
    rolePublicId: r.role_public_id,
    systemKey: r.system_key,
    roleName: r.role_name,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
/** Member + user + role; `org_roles` join theo FK kép `(org_id, role_id)`. */
export const MEMBER_SELECT = `SELECT m.id::text AS id, m.public_id::text AS public_id, m.user_id::text AS user_id,
    u.public_id::text AS user_public_id, u.auth_user_id::text AS auth_user_id, u.external_subject,
    m.role_id::text AS role_id, r.public_id::text AS role_public_id, r.system_key, r.name AS role_name,
    m.version, m.created_at, m.updated_at
  FROM org_members m
  JOIN tenancy_users u ON u.id = m.user_id
  JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id`;

export function single<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (!row || rows.length !== 1)
    throw new Error(`${what}: expected exactly one row, got ${rows.length}`);
  return row;
}
