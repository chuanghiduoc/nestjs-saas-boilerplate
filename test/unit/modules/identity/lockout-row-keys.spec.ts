import { describe, expect, it } from 'vitest';
import { emailHash } from '../../../../src/modules/identity/infra/better-auth/email-normalize.js';
import {
  accountKey,
  lockoutRowKeys,
} from '../../../../src/modules/identity/infra/better-auth/login-lockout.js';

describe('lockout row keys (spec SP3 §5.2 hàng auth-hooks.ts (1), r6 N6-2)', () => {
  it('accountKey: signin hashes the email, step-up keys by user id', () => {
    expect(accountKey({ kind: 'signin', email: 'a@example.test' })).toBe(
      `signin:${emailHash('a@example.test')}`,
    );
    expect(
      accountKey({
        kind: 'step-up',
        userId: '0190e1c8-0000-7000-8000-000000000001',
      }),
    ).toBe('step-up:0190e1c8-0000-7000-8000-000000000001');
  });
  it('rows: the block row exactly, attempts and tickets of every window by prefix', () => {
    const scope = { kind: 'step-up', userId: 'u' } as const;
    expect(lockoutRowKeys(scope)).toEqual({
      exact: ['blocks:step-up:u'],
      prefixes: ['attempts:step-up:u:', 'tickets:step-up:u:'],
    });
  });
});
