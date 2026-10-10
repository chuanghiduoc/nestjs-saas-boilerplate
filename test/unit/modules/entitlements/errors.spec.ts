import { describe, expect, it } from 'vitest';
import {
  dbErrorMapper,
  defineConstraintErrors,
} from '../../../../src/core/database/index.js';
import { CoreErrors, toAppError } from '../../../../src/core/errors/index.js';
import * as api from '../../../../src/modules/entitlements/index.js';

const pgError = (code: string, constraint: string): Error =>
  Object.assign(new Error('violation'), { code, constraint });
const NAMED = [
  'EntitlementsContextError',
  'UnknownPlanError',
  'EntitlementsRowMissingError',
  'EntitlementsVersionSkewError',
  'UnknownFeatureError',
  'FeatureKindMismatchError',
  'QuotaReleaseUnderflowError',
] as const;

describe('entitlements errors (spec SP4 §6.4, §15, R-X19, EC-10)', () => {
  it('index exports the seven named error classes and EntitlementsErrors', () => {
    for (const name of NAMED) expect(typeof api[name], name).toBe('function');
    expect([
      api.EntitlementsErrors.PLAN_RETIRED.code,
      api.EntitlementsErrors.PLAN_RETIRED.status,
    ]).toEqual(['plan_retired', 422]);
    expect([
      api.EntitlementsErrors.UNKNOWN_PLAN.code,
      api.EntitlementsErrors.UNKNOWN_PLAN.status,
    ]).toEqual(['unknown_plan', 422]);
  });
  it('a missing row is 503 with Retry-After from the error; version skew is 503; programmer errors stay 500', () => {
    const missing = toAppError(new api.EntitlementsRowMissingError(7));
    expect([missing.error.code, missing.opts.headers]).toEqual([
      'service_unavailable',
      { 'Retry-After': '7' },
    ]);
    expect(
      toAppError(new api.EntitlementsVersionSkewError('gold')).error.code,
    ).toBe('service_unavailable');
    for (const err of [
      new api.UnknownFeatureError('x.y'),
      new api.UnknownPlanError('gold'),
      new api.EntitlementsContextError('no org'),
    ])
      expect(toAppError(err).error.code).toBe('internal_error');
  });
  it('trigger names map to codes (the name never reaches the client)', () => {
    expect(
      dbErrorMapper(pgError('23514', 'org_entitlements_plan_not_retired'))
        ?.error,
    ).toBe(api.EntitlementsErrors.PLAN_RETIRED);
    expect(
      dbErrorMapper(pgError('23514', 'org_entitlements_billing_seq_monotonic'))
        ?.error.code,
    ).toBe('validation_failed');
    expect(
      dbErrorMapper(pgError('23514', 'usage_counters_period_ck'))?.error.code,
    ).toBe('validation_failed');
    expect(
      dbErrorMapper(pgError('23514', 'org_entitlement_overrides_value_ck'))
        ?.error.code,
    ).toBe('validation_failed');
  });
  it('every VALIDATION_FAILED trigger and CHECK of entitlements is registered by name (every unregistered 23514 also maps to validation_failed, so the mapping alone proves nothing)', () => {
    // `defineConstraintErrors` ném khi tên đã có: ném = errors.ts đã đăng ký tên đó lúc import.
    for (const name of [
      'org_entitlements_billing_seq_monotonic',
      'usage_counters_period_ck',
      'org_entitlement_overrides_value_ck',
      'org_entitlement_overrides_expiry_ck',
    ])
      expect(
        () => defineConstraintErrors({ [name]: CoreErrors.VALIDATION_FAILED }),
        name,
      ).toThrow(`Constraint "${name}" already mapped`);
  });
});
