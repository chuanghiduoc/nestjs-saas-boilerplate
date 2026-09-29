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
export type EscalationRule = '2' | '2a' | '3' | '4' | '5';
export type EscalationDecision =
  | { ok: true }
  | {
      ok: false;
      rule: EscalationRule;
      reason: 'ESCALATION_DENIED' | 'OWNER_ONLY' | 'CANNOT_CHANGE_OWN_ROLE';
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
