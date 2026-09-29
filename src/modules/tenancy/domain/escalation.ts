import type { SystemRoleKey } from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure, isStrictSubset, isSubset } from './permission-set.js';
import { adminCapability } from './system-roles.js';

export type Actor = {
  memberRef: string;
  isOwner: boolean;
  permissions: ReadonlySet<string>;
};
export type BindTarget = {
  systemKey: SystemRoleKey | null;
  permissions: ReadonlySet<string>;
};
export type ManagedMember = {
  memberRef: string;
  isOwner: boolean;
  permissions: ReadonlySet<string>;
};
export type EscalationRule = '1' | '2' | '2a' | '3' | '4' | '5' | '6';
export type EscalationDecision =
  | { ok: true }
  | {
      ok: false;
      rule: EscalationRule;
      reason:
        | 'ESCALATION_DENIED'
        | 'OWNER_ONLY'
        | 'CANNOT_CHANGE_OWN_ROLE'
        | 'CANNOT_EDIT_OWN_ROLE';
    };

const ALLOWED: EscalationDecision = { ok: true };

/** `dominates(actor, S)` ≔ actor là OWNER hoặc `perms(S) ⊊ perms(actor)` (spec §8.4, S3-A4): so tập, không theo hạng. */
export function dominates(
  actor: Actor,
  target: ReadonlySet<string>,
  merged: MergedCatalogue,
): boolean {
  return (
    actor.isOwner ||
    isStrictSubset(closure(target, merged), closure(actor.permissions, merged))
  );
}

/** Luật 2a (S3-A41): tương đương admin về NĂNG LỰC khi closure của tập chứa toàn bộ `A = perms(ADMIN)`. */
export const isAdminEquivalent = (
  s: ReadonlySet<string>,
  merged: MergedCatalogue,
): boolean => isSubset(adminCapability(merged), closure(s, merged));

/** Luật 2 + 2a(iv) + 5 cho MỌI đường gán role (PR4): đổi role (3A); lời mời, link (3C); dùng lại, không viết lại. */
export function assertCanBind(
  actor: Actor,
  role: BindTarget,
  merged: MergedCatalogue,
): EscalationDecision {
  if (role.systemKey === 'OWNER' && !actor.isOwner)
    return { ok: false, rule: '5', reason: 'OWNER_ONLY' };
  if (!actor.isOwner && isAdminEquivalent(role.permissions, merged))
    return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, role.permissions, merged))
    return { ok: false, rule: '2', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 4 + 2a(v) + 5: quản lý người khác (đổi role, xoá khỏi org; thu hồi key của họ ở 3D) so với quyền HIỆN TẠI của họ. */
export function assertCanManage(
  actor: Actor,
  target: ManagedMember,
  merged: MergedCatalogue,
): EscalationDecision {
  if (target.isOwner && !actor.isOwner)
    return { ok: false, rule: '5', reason: 'OWNER_ONLY' };
  if (!actor.isOwner && isAdminEquivalent(target.permissions, merged))
    return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, target.permissions, merged))
    return { ok: false, rule: '4', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 3 (PR11): không tự đổi role của mình, kể cả owner (owner xuống quyền chỉ qua chuyển quyền sở hữu, 3C). */
export function assertNotSelf(
  actor: Actor,
  targetRef: string,
): EscalationDecision {
  return actor.memberRef === targetRef
    ? { ok: false, rule: '3', reason: 'CANNOT_CHANGE_OWN_ROLE' }
    : ALLOWED;
}

/** Luật 1 (tạo) + 2a(i) (spec SP3 §8.4): 2a trước, vì tập ⊇ A là việc của owner dù actor có trội hẳn hay không. */
export function assertCanCreateRole(
  actor: Actor,
  newSet: ReadonlySet<string>,
  merged: MergedCatalogue,
): EscalationDecision {
  if (actor.isOwner) return ALLOWED;
  if (isAdminEquivalent(newSet, merged))
    return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, newSet, merged))
    return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/**
 * Luật 6 + 2a(ii) + 1 (sửa, SEC-C1): sửa role đang có người giữ là đổi quyền của mọi người giữ nó (luật 4), nên actor phải
 * trội hẳn CẢ tập cũ lẫn tập mới. Người giữ role không sửa được nó (PR15), kể cả để thu hẹp.
 */
export function assertCanEditRole(
  actor: Actor,
  edit: {
    heldByActor: boolean;
    oldSet: ReadonlySet<string>;
    newSet: ReadonlySet<string>;
  },
  merged: MergedCatalogue,
): EscalationDecision {
  if (edit.heldByActor)
    return { ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' };
  if (actor.isOwner) return ALLOWED;
  if (
    isAdminEquivalent(edit.oldSet, merged) ||
    isAdminEquivalent(edit.newSet, merged)
  )
    return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (
    !dominates(actor, edit.oldSet, merged) ||
    !dominates(actor, edit.newSet, merged)
  )
    return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 1 (xoá, PR17) + 2a(iii): so với tập hiện tại của role. Role còn người giữ thì FK `RESTRICT` từ chối (409 role_in_use). */
export function assertCanDeleteRole(
  actor: Actor,
  oldSet: ReadonlySet<string>,
  merged: MergedCatalogue,
): EscalationDecision {
  if (actor.isOwner) return ALLOWED;
  if (isAdminEquivalent(oldSet, merged))
    return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, oldSet, merged))
    return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}
