import { AppError } from '../../../core/errors/index.js';
import type { DelegationKind, ScopeCheck } from '../domain/delegation.js';
import { TenancyErrors } from '../errors.js';
import type { EscalationGuard } from './escalation-guard.js';

/**
 * Lỗi của `checkDelegatedScope` → HTTP (spec SP3 §10, §15): `fields` liệt kê key vi phạm (như `RoleService`); vượt người
 * ủy quyền đi qua `EscalationGuard` (metric `tenancy_escalation_denied_total{rule="delegation"}`, WARN không kèm tập quyền).
 */
export function scopeOrThrow(
  kind: DelegationKind,
  check: ScopeCheck,
  escalation: EscalationGuard,
): string[] {
  if (check.ok) return check.scope;
  const fields = (code: string) =>
    check.keys.map((key) => ({ path: 'permissions', code, message: key }));
  switch (check.reason) {
    case 'UNKNOWN_PERMISSION':
      throw new AppError(TenancyErrors.UNKNOWN_PERMISSION, {
        fields: fields('unknown_permission'),
      });
    case 'NOT_ELIGIBLE':
      throw kind === 'API_KEY'
        ? new AppError(TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE, {
            fields: fields('permission_not_api_key_eligible'),
          })
        : new AppError(TenancyErrors.PERMISSION_NOT_SUPPORT_ELIGIBLE, {
            fields: fields('permission_not_support_eligible'),
          });
    case 'MISSING_DEPENDENCIES':
      throw new AppError(TenancyErrors.MISSING_DEPENDENCIES, {
        fields: fields('missing_dependency'),
      });
    case 'EXCEEDS_GRANTOR':
      escalation.enforce({
        ok: false,
        rule: 'delegation',
        reason: 'ESCALATION_DENIED',
      });
      throw new Error('EscalationGuard.enforce returned on a refusal');
    default: {
      const unknown: never = check.reason;
      throw new Error(`unknown delegation scope problem ${String(unknown)}`);
    }
  }
}
