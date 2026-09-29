import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

/**
 * Event của 3A (spec SP3 §14): chỉ id công khai, không email/token/tên người. `userId` là `tenancy_users.public_id`
 * (INT-I14); org của event là org của context (EventPublisher), không có trong `data` ngoài `orgId` tường minh.
 */
const id = z.uuid();
export const OrgCreatedEvent = defineEvent({
  type: 'tenancy.org.created',
  version: 1,
  schema: z.object({ orgId: id, createdByUserId: id }),
});
export const OrgUpdatedEvent = defineEvent({
  type: 'tenancy.org.updated',
  version: 1,
  schema: z.object({ orgId: id, changed: z.array(z.enum(['name'])).min(1) }),
});
export const OrgDeletedEvent = defineEvent({
  type: 'tenancy.org.deleted',
  version: 1,
  schema: z.object({ orgId: id, purgeAfter: z.iso.datetime() }),
});
export const OrgRestoredEvent = defineEvent({
  type: 'tenancy.org.restored',
  version: 1,
  schema: z.object({ orgId: id }),
});
export const OrgPurgedEvent = defineEvent({
  type: 'tenancy.org.purged',
  version: 1,
  schema: z.object({ orgId: id }),
});
export const MemberAddedEvent = defineEvent({
  type: 'tenancy.member.added',
  version: 1,
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
  schema: z.object({
    memberId: id,
    userId: id,
    roleId: id,
    reason: z.enum(['REMOVED', 'LEFT', 'ACCOUNT_DELETED']),
  }),
});
