import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { STEP_DOWN_ROLES } from './constants.js';
import { INVALIDATION_REASONS } from './domain/invitation.js';
import { INVITE_LINK_REVOKE_REASONS } from './domain/invite-link.js';
import { API_KEY_REVOKE_REASONS } from './domain/org-api-key.js';
import { TRANSFER_CANCEL_REASONS } from './domain/ownership-transfer.js';
import { SUPPORT_GRANT_REVOKE_REASONS } from './domain/support-grant.js';

/**
 * Event của 3A (spec SP3 §14): chỉ id công khai, không email/token/tên người. `userId` là `tenancy_users.public_id`
 * (INT-I14); org của event là org của context (EventPublisher), không có trong `data` ngoài `orgId` tường minh.
 * Cờ audit/webhook (R-X3, spec SP6 §8.3): mọi event tenancy vào audit; sáu event là hợp đồng webhook công khai (đổi schema
 * phải lên version).
 */
const id = z.uuid();
export const OrgCreatedEvent = defineEvent({
  type: 'tenancy.org.created',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ orgId: id, createdByUserId: id }),
});
export const OrgUpdatedEvent = defineEvent({
  type: 'tenancy.org.updated',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({ orgId: id, changed: z.array(z.enum(['name'])).min(1) }),
});
export const OrgDeletedEvent = defineEvent({
  type: 'tenancy.org.deleted',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({ orgId: id, purgeAfter: z.iso.datetime() }),
});
export const OrgRestoredEvent = defineEvent({
  type: 'tenancy.org.restored',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({ orgId: id }),
});
export const OrgPurgedEvent = defineEvent({
  type: 'tenancy.org.purged',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ orgId: id }),
});
export const MemberAddedEvent = defineEvent({
  type: 'tenancy.member.added',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({
    memberId: id,
    userId: id,
    roleId: id,
    source: z.enum(['CREATOR', 'INVITATION', 'INVITE_LINK']),
    invitationId: id.optional(),
    inviteLinkId: id.optional(),
  }),
});
export const MemberRoleChangedEvent = defineEvent({
  type: 'tenancy.member.role_changed',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({
    memberId: id,
    userId: id,
    fromRoleId: id,
    toRoleId: id,
    reason: z.enum(['ASSIGNED', 'OWNERSHIP_TRANSFER']),
  }),
});
export const MemberRemovedEvent = defineEvent({
  type: 'tenancy.member.removed',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({
    memberId: id,
    userId: id,
    roleId: id,
    reason: z.enum(['REMOVED', 'LEFT', 'ACCOUNT_DELETED']),
  }),
});

const permissionKeys = z.array(z.string());
/** Spec §14: tập quyền cuối cùng (đã sắp, không deprecated). `.updated` cũng do migration catalogue phát (actor system). */
export const RoleCreatedEvent = defineEvent({
  type: 'tenancy.role.created',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ roleId: id, permissions: permissionKeys }),
});
export const RoleUpdatedEvent = defineEvent({
  type: 'tenancy.role.updated',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ roleId: id, permissions: permissionKeys }),
});
export const RoleDeletedEvent = defineEvent({
  type: 'tenancy.role.deleted',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ roleId: id }),
});
/**
 * Event của 3C (spec SP3 §14): chỉ id công khai, không email, token, tên người. Cờ R-X3: vào audit, không phải hợp đồng
 * webhook công khai (sáu event webhook đều là của 3A, spec SP6 §8.3).
 */
const invitation = z.object({ invitationId: id, roleId: id });
const transfer = z.object({
  transferId: id,
  fromMemberId: id,
  toMemberId: id,
  stepDownTo: z.enum(STEP_DOWN_ROLES).nullable(),
});
export const InvitationCreatedEvent = defineEvent({
  type: 'tenancy.invitation.created',
  version: 1,
  schema: invitation,
  audit: true,
  webhook: false,
});
export const InvitationRevokedEvent = defineEvent({
  type: 'tenancy.invitation.revoked',
  version: 1,
  schema: invitation,
  audit: true,
  webhook: false,
});
export const InvitationAcceptedEvent = defineEvent({
  type: 'tenancy.invitation.accepted',
  version: 1,
  schema: invitation.extend({ memberId: id }),
  audit: true,
  webhook: false,
});
export const InvitationInvalidatedEvent = defineEvent({
  type: 'tenancy.invitation.invalidated',
  version: 1,
  schema: invitation.extend({ reason: z.enum(INVALIDATION_REASONS) }),
  audit: true,
  webhook: false,
});
export const InviteLinkCreatedEvent = defineEvent({
  type: 'tenancy.invite_link.created',
  version: 1,
  schema: z.object({
    inviteLinkId: id,
    roleId: id,
    maxUses: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  }),
  audit: true,
  webhook: false,
});
export const InviteLinkRevokedEvent = defineEvent({
  type: 'tenancy.invite_link.revoked',
  version: 1,
  schema: z.object({
    inviteLinkId: id,
    reason: z.enum(INVITE_LINK_REVOKE_REASONS),
  }),
  audit: true,
  webhook: false,
});
export const OwnershipTransferRequestedEvent = defineEvent({
  type: 'tenancy.ownership_transfer.requested',
  version: 1,
  schema: transfer,
  audit: true,
  webhook: false,
});
export const OwnershipTransferAcceptedEvent = defineEvent({
  type: 'tenancy.ownership_transfer.accepted',
  version: 1,
  schema: transfer,
  audit: true,
  webhook: false,
});
export const OwnershipTransferDeclinedEvent = defineEvent({
  type: 'tenancy.ownership_transfer.declined',
  version: 1,
  schema: transfer,
  audit: true,
  webhook: false,
});
export const OwnershipTransferCancelledEvent = defineEvent({
  type: 'tenancy.ownership_transfer.cancelled',
  version: 1,
  schema: transfer.extend({ reason: z.enum(TRANSFER_CANCEL_REASONS) }),
  audit: true,
  webhook: false,
});

/**
 * Event của 3D (spec SP3 §14): chỉ id công khai; không `key_hint`, không `reason` của grant, không token. `granteeUserId`
 * là `tenancy_users.public_id` (`null` khi tài khoản nhân viên đã bị xoá: FK SET NULL); `grantedByMemberId` `null` khi
 * owner cấp đã rời org. Cờ R-X3: vào audit, không phải hợp đồng webhook công khai.
 */
const apiKey = z.object({
  apiKeyId: id,
  createdByMemberId: id,
  permissions: permissionKeys,
  expiresAt: z.iso.datetime(),
});
const grant = z.object({
  grantId: id,
  granteeUserId: id.nullable(),
  grantedByMemberId: id.nullable(),
  permissions: permissionKeys,
  expiresAt: z.iso.datetime(),
});
export const ApiKeyCreatedEvent = defineEvent({
  type: 'tenancy.api_key.created',
  version: 1,
  schema: apiKey,
  audit: true,
  webhook: false,
});
export const ApiKeyRevokedEvent = defineEvent({
  type: 'tenancy.api_key.revoked',
  version: 1,
  schema: z.object({ apiKeyId: id, reason: z.enum(API_KEY_REVOKE_REASONS) }),
  audit: true,
  webhook: false,
});
export const ApiKeyScopeNarrowedEvent = defineEvent({
  type: 'tenancy.api_key.scope_narrowed',
  version: 1,
  schema: z.object({ apiKeyId: id, permissions: permissionKeys }),
  audit: true,
  webhook: false,
});
export const SupportAccessGrantedEvent = defineEvent({
  type: 'tenancy.support_access.granted',
  version: 1,
  schema: grant,
  audit: true,
  webhook: false,
});
export const SupportAccessUsedEvent = defineEvent({
  type: 'tenancy.support_access.used',
  version: 1,
  schema: grant,
  audit: true,
  webhook: false,
});
export const SupportAccessRevokedEvent = defineEvent({
  type: 'tenancy.support_access.revoked',
  version: 1,
  schema: grant.extend({ reason: z.enum(SUPPORT_GRANT_REVOKE_REASONS) }),
  audit: true,
  webhook: false,
});
export const SupportAccessScopeNarrowedEvent = defineEvent({
  type: 'tenancy.support_access.scope_narrowed',
  version: 1,
  schema: z.object({ grantId: id, permissions: permissionKeys }),
  audit: true,
  webhook: false,
});
