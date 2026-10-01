import { describe, expect, it } from 'vitest';
import {
  decideAssignment,
  type AssignmentCause,
  type CurrentAssignment,
  type TargetPlan,
} from '../../../../src/modules/entitlements/domain/plan-assignment.js';

const cur = (o: Partial<CurrentAssignment> = {}): CurrentAssignment => ({
  planKey: 'free',
  source: 'BILLING',
  sourceRef: 'sub_1',
  lastBillingSeq: 5n,
  version: 3,
  ...o,
});
const pro: TargetPlan = { key: 'pro', retired: false };
const billing = (sequence: bigint, ref = 'sub_1'): AssignmentCause => ({
  kind: 'BILLING',
  ref,
  sequence,
});
const admin = (expectedVersion: number): AssignmentCause => ({
  kind: 'PLATFORM_ADMIN',
  reason: 'goodwill',
  expectedVersion,
});

describe('decideAssignment (spec SP4 §10.2 bước 3, PA-1…PA-8)', () => {
  it('PA-1: a billing sequence below the last one is STALE, naming the last one', () => {
    expect(decideAssignment(cur(), pro, billing(4n))).toEqual({
      kind: 'STALE',
      lastBillingSeq: 5n,
    });
  });
  it('PA-2: an equal sequence is STALE (a replayed command)', () => {
    expect(decideAssignment(cur(), pro, billing(5n))).toEqual({
      kind: 'STALE',
      lastBillingSeq: 5n,
    });
  });
  it('PA-3: a greater sequence applies', () => {
    expect(decideAssignment(cur(), pro, billing(6n))).toEqual({
      kind: 'APPLY',
    });
  });
  it('PA-4: with no billing command yet, any sequence is new', () => {
    expect(
      decideAssignment(
        cur({ source: 'DEFAULT', sourceRef: null, lastBillingSeq: null }),
        pro,
        billing(1n),
      ),
    ).toEqual({ kind: 'APPLY' });
  });
  it('PA-5: a staff command with the wrong version is a VERSION_MISMATCH (412 before any write)', () => {
    expect(decideAssignment(cur(), pro, admin(2))).toEqual({
      kind: 'VERSION_MISMATCH',
    });
    expect(decideAssignment(cur(), pro, admin(3))).toEqual({ kind: 'APPLY' });
  });
  it('PA-6: a retired target different from the current plan is REJECTED_RETIRED; the same retired plan is kept', () => {
    const legacy: TargetPlan = { key: 'legacy', retired: true };
    expect(decideAssignment(cur(), legacy, billing(6n))).toEqual({
      kind: 'REJECTED_RETIRED',
    });
    expect(decideAssignment(cur(), legacy, admin(3))).toEqual({
      kind: 'REJECTED_RETIRED',
    });
    expect(
      decideAssignment(cur({ planKey: 'legacy' }), legacy, billing(6n)),
    ).toEqual({ kind: 'UNCHANGED' });
    expect(
      decideAssignment(
        cur({ planKey: 'legacy' }),
        legacy,
        billing(6n, 'sub_2'),
      ),
    ).toEqual({ kind: 'APPLY' });
  });
  it('PA-7: the same plan from another source or subscription applies (billing takes the slot back)', () => {
    expect(
      decideAssignment(
        cur({ planKey: 'pro', source: 'PLATFORM_ADMIN', sourceRef: null }),
        pro,
        billing(6n),
      ),
    ).toEqual({ kind: 'APPLY' });
    expect(
      decideAssignment(cur({ planKey: 'pro' }), pro, billing(6n, 'sub_2')),
    ).toEqual({ kind: 'APPLY' });
    expect(decideAssignment(cur({ planKey: 'pro' }), pro, admin(3))).toEqual({
      kind: 'APPLY',
    });
  });
  it('PA-8: same plan, same source, same ref is UNCHANGED (renewal); staff re-assigning its own plan too', () => {
    expect(decideAssignment(cur({ planKey: 'pro' }), pro, billing(6n))).toEqual(
      { kind: 'UNCHANGED' },
    );
    expect(
      decideAssignment(
        cur({ planKey: 'pro', source: 'PLATFORM_ADMIN', sourceRef: null }),
        pro,
        admin(3),
      ),
    ).toEqual({ kind: 'UNCHANGED' });
  });
  it('sequences beyond 2^53 compare as bigint', () => {
    const big = 2n ** 53n + 1n;
    expect(
      decideAssignment(cur({ lastBillingSeq: big }), pro, billing(big + 1n)),
    ).toEqual({ kind: 'APPLY' });
    expect(
      decideAssignment(cur({ lastBillingSeq: big + 1n }), pro, billing(big)),
    ).toEqual({ kind: 'STALE', lastBillingSeq: big + 1n });
  });
});
