import { describe, expect, it } from 'vitest';
import { resetPasswordToken } from '../../../../src/modules/identity/infra/better-auth/auth-hooks.js';

/** Spec SP3 §5.2 (7), r7 N7-1: đúng biểu thức của handler `ctx.body.token || ctx.query?.token`. */
describe('resetPasswordToken', () => {
  it.each([
    [{ token: 'b' }, { token: 'q' }, 'b'],
    [{ token: '' }, { token: 'q' }, 'q'],
    [{}, { token: 'q' }, 'q'],
    [{ token: 5 }, { token: 'q' }, 'q'],
    [{}, {}, undefined],
    [{}, { token: ['q1', 'q2'] }, undefined],
  ])('body %j + query %j → %j', (body, query, expected) => {
    expect(resetPasswordToken(body, query)).toBe(expected);
  });
});
