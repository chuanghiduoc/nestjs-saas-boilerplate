import { describe, expect, it } from 'vitest';
import {
  periodOf,
  reachedLimit,
} from '../../../../src/modules/entitlements/domain/quota.js';

describe('quota domain (spec SP4 §9.1, §11 periodOf, S4-D16, E-10)', () => {
  it('periodOf: NONE has no period; MONTH carries the configured timezone (the DB computes the instant)', () => {
    expect(periodOf('NONE', 'Asia/Ho_Chi_Minh')).toEqual({ kind: 'NONE' });
    expect(periodOf('MONTH', 'Asia/Ho_Chi_Minh')).toEqual({
      kind: 'MONTH',
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });
  it.each([
    [3, 3, 1, true],
    [3, 3, 3, true],
    [3, 2, 1, false],
    [3, 1, 1, false],
    [1, 1, 1, true],
  ])(
    'reachedLimit(max %i, used %i, amount %i) = %s: only the consume that crosses the limit',
    (max, used, amount, out) => {
      expect(reachedLimit(max, used, amount)).toBe(out);
    },
  );
});
