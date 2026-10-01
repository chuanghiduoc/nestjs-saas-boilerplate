import { z } from 'zod';
import { mergePatchSchema, offsetPageQuery } from '../../../core/http/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { normalizeEmail } from '../../identity/index.js';
import {
  INVITATION_EMAIL_MAX_LENGTH,
  ROLE_PERMISSIONS_MAX,
  SYSTEM_ROLE_KEYS,
  TOKEN_INPUT_MAX_LENGTH,
} from '../constants.js';
import {
  INVITATION_STATUSES,
  type InvitationStatus,
} from '../domain/invitation.js';
import type { TokenPreview } from '../application/invitation.service.js';
import type { InvitationRow } from '../ports/invitation-repository.js';
import { PERMISSION_KEY_PATTERN } from '../domain/catalogue.js';
import { roleDescription, roleName } from '../domain/role.js';
import { orgName } from '../domain/organization.js';
import type { MemberView } from '../application/member.service.js';
import type { OrgRow, UserOrgRow } from '../ports/org-repository.js';
import type { RoleRow } from '../ports/role-repository.js';

const iso = z.iso.datetime();
/** Resource `Organization` (spec SP3 §12): camelCase, nullable luôn có mặt. */
export const OrganizationResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  deletedAt: iso.nullable(),
  purgeAfter: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type OrganizationResponse = z.infer<typeof OrganizationResponse>;
export const organizationOf = (o: OrgRow): OrganizationResponse => ({
  id: o.id,
  name: o.name,
  deletedAt: o.deletedAt?.toISOString() ?? null,
  purgeAfter: o.purgeAfter?.toISOString() ?? null,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

/**
 * Một dòng của `GET /v1/orgs`: đúng các cột mà hàm definer `tenancy_list_user_orgs` trả (spec SP3 §6.14 cố định chữ ký,
 * không có `createdAt` của org), cộng membership của chính principal.
 */
export const OrgListItem = z.object({
  id: z.uuid(),
  name: z.string(),
  deletedAt: iso.nullable(),
  purgeAfter: iso.nullable(),
  membership: z.object({
    memberId: z.uuid(),
    role: z.object({
      id: z.uuid(),
      systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
      name: z.string().nullable(),
    }),
    joinedAt: iso,
  }),
});
export const orgListItemOf = (r: UserOrgRow): z.infer<typeof OrgListItem> => ({
  id: r.orgId,
  name: r.orgName,
  deletedAt: r.orgDeletedAt?.toISOString() ?? null,
  purgeAfter: r.orgPurgeAfter?.toISOString() ?? null,
  membership: {
    memberId: r.memberPublicId,
    role: {
      id: r.rolePublicId,
      systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable().parse(r.roleSystemKey),
      name: r.roleName,
    },
    joinedAt: r.joinedAt.toISOString(),
  },
});

/** `z.object` bỏ khoá lạ: `id` do client gửi bị bỏ qua (Review Focus 5). */
export const CreateOrgBody = z.object({ name: orgName });
export const PatchOrgBody = mergePatchSchema(z.object({ name: orgName }));
export const ListOrgsPage = offsetPageQuery({
  sortable: ['joinedAt'] as const,
});
export const IncludeDeletedQuery = z.object({
  includeDeleted: z.stringbool().default(false),
});

export const PermissionResponse = z.object({
  key: z.string(),
  resource: z.string(),
  action: z.string(),
  requires: z.array(z.string()),
  ownerOnly: z.boolean(),
  apiKeyEligible: z.boolean(),
  supportEligible: z.boolean(),
});
export const PermissionListResponse = z.object({
  data: z.array(PermissionResponse),
});

export const MemberResponse = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  role: z.object({
    id: z.uuid(),
    systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    name: z.string().nullable(),
  }),
  email: z.string().nullable(),
  name: z.string().nullable(),
  joinedAt: iso,
  updatedAt: iso,
});
export const memberOf = (m: MemberView): z.infer<typeof MemberResponse> => ({
  id: m.publicId,
  userId: m.userPublicId,
  role: { id: m.rolePublicId, systemKey: m.systemKey, name: m.roleName },
  email: m.email,
  name: m.name,
  joinedAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});
export const ListMembersPage = offsetPageQuery({
  sortable: ['joinedAt'] as const,
});
export const RoleFilterQuery = z.object({ roleId: z.uuid().optional() });
export const ChangeRoleBody = z.object({ roleId: z.uuid() }).strict();
export const PublicIdParam = z.uuid();

export const RoleResponse = z.object({
  id: z.uuid(),
  systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  createdAt: iso,
  updatedAt: iso,
});
export const roleOf = (
  r: RoleRow,
  permissions: readonly string[],
): z.infer<typeof RoleResponse> => ({
  id: r.publicId,
  systemKey: r.systemKey,
  name: r.name,
  description: r.description,
  permissions: [...permissions],
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
export const RoleListResponse = z.object({ data: z.array(RoleResponse) });

export const PermissionKey = z
  .string()
  .regex(PERMISSION_KEY_PATTERN, 'must be a permission key (resource.action)');
const permissionList = z.array(PermissionKey).max(ROLE_PERMISSIONS_MAX);
export const CreateRoleBody = z
  .object({
    name: roleName,
    description: roleDescription.nullable().default(null),
    permissions: permissionList,
  })
  .strict();
/** Merge-patch (SP1): `description: null` xoá mô tả; `name: null` → 422 (không nullable); `permissions` thay nguyên mảng. */
export const PatchRoleBody = mergePatchSchema(
  z.object({
    name: roleName,
    description: roleDescription.nullable(),
    permissions: permissionList,
  }),
);
/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
export const publicIdOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
export const RoleRefResponse = z.object({
  id: z.uuid(),
  systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
  name: z.string().nullable(),
});
/** `role` là `null` khi role đã bị xoá sau khi lời mời/link kết thúc (spec §12, DB-I2). */
export const roleRefOf = (r: {
  rolePublicId: string | null;
  roleSystemKey: (typeof SYSTEM_ROLE_KEYS)[number] | null;
  roleName: string | null;
}) =>
  r.rolePublicId === null
    ? null
    : { id: r.rolePublicId, systemKey: r.roleSystemKey, name: r.roleName };
/**
 * Review Focus 1: chuẩn hoá `trim → lowercase → NFC` bằng CÙNG hàm của identity rồi mới kiểm định dạng và độ dài, nên
 * `" Ann@Example.TEST "` thành `ann@example.test`; độ dài so bằng đơn vị UTF-16 (≥ số code point mà `char_length` đếm).
 */
export const InvitationEmail = z
  .string()
  .transform(normalizeEmail)
  .refine(
    (e) =>
      e.length <= INVITATION_EMAIL_MAX_LENGTH && z.email().safeParse(e).success,
    'must be an email address',
  );
export const CreateInvitationBody = z
  .object({ email: InvitationEmail, roleId: z.uuid() })
  .strict();
export const InvitationResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  role: RoleRefResponse.nullable(),
  status: z.enum(INVITATION_STATUSES),
  expiresAt: iso,
  createdAt: iso,
  resolvedAt: iso.nullable(),
});
export const invitationOf = (
  i: InvitationRow & { status: InvitationStatus },
): z.infer<typeof InvitationResponse> => ({
  id: i.publicId,
  email: i.email,
  role: roleRefOf(i),
  status: i.status,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
});
export const ListAcquisitionPage = offsetPageQuery({
  sortable: ['createdAt'] as const,
});
/** Review Focus 3: thiếu/sai kiểu/ngoài base64url/quá dài → 422; đúng kiểu mà không phải token nào → 404 thống nhất. */
export const TokenBody = z
  .object({
    token: z
      .string()
      .min(1)
      .max(TOKEN_INPUT_MAX_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/, 'must be a base64url token'),
  })
  .strict();
/** Preview (spec §9.1): không email được mời, không tên người mời — người cầm token đã có thư. */
export const TokenPreviewResponse = z.object({
  orgName: z.string(),
  roleName: z.string(),
  expiresAt: iso,
});
export const tokenPreviewOf = (
  p: TokenPreview,
): z.infer<typeof TokenPreviewResponse> => ({
  orgName: p.orgName,
  roleName: p.roleName,
  expiresAt: p.expiresAt.toISOString(),
});
