import { z } from 'zod';
import { mergePatchSchema, offsetPageQuery } from '../../../core/http/index.js';
import { SYSTEM_ROLE_KEYS } from '../constants.js';
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
