import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import { EscalationGuard } from '../../../../src/modules/tenancy/application/escalation-guard.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { TenancyErrors } from '../../../../src/modules/tenancy/errors.js';

describe('EscalationGuard (spec SP3 §8.4, §15, §16)', () => {
  const guard = new EscalationGuard(new TenancyMetrics());
  it('passes an allowed decision', () => {
    expect(() => guard.enforce({ ok: true })).not.toThrow();
  });
  it.each([
    [
      { ok: false, rule: '1', reason: 'ESCALATION_DENIED' } as const,
      TenancyErrors.ESCALATION_DENIED,
    ],
    [
      { ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' } as const,
      TenancyErrors.CANNOT_EDIT_OWN_ROLE,
    ],
    [
      { ok: false, rule: '5', reason: 'OWNER_ONLY' } as const,
      TenancyErrors.OWNER_ONLY,
    ],
    [
      { ok: false, rule: '2a', reason: 'OWNER_ONLY' } as const,
      TenancyErrors.OWNER_ONLY,
    ],
    [
      { ok: false, rule: '2', reason: 'ESCALATION_DENIED' } as const,
      TenancyErrors.ESCALATION_DENIED,
    ],
    [
      { ok: false, rule: '3', reason: 'CANNOT_CHANGE_OWN_ROLE' } as const,
      TenancyErrors.CANNOT_CHANGE_OWN_ROLE,
    ],
  ])('%j → %j', (decision, code) => {
    let caught: unknown;
    try {
      guard.enforce(decision);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).error).toBe(code);
  });
});
