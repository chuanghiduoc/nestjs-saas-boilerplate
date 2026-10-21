import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../../../../src/core/context/index.js';
import {
  principalActor,
  userActor,
} from '../../../../src/core/events/index.js';

const ctxOf = (
  p: { type: 'user' | 'api_key' | 'service'; id: string } | undefined,
) => ({ principal: () => p }) as unknown as RequestContext; // chỉ `principal()` được đọc

describe('event actors (spec SP3 §14, review 7D M2)', () => {
  it.each([
    [
      { type: 'user', id: 'u1' },
      { type: 'user', id: 'u1' },
    ],
    [
      { type: 'api_key', id: 'k1' },
      { type: 'service', id: 'api_key:k1' },
    ],
    [
      { type: 'service', id: 's1' },
      { type: 'service', id: 's1' },
    ],
  ] as const)('principalActor(%j) → %j', (p, actor) => {
    expect(principalActor(ctxOf(p))).toEqual(actor);
  });
  it('no principal → undefined (the caller picks its system actor or throws)', () => {
    expect(principalActor(ctxOf(undefined))).toBeUndefined();
  });
  it('userActor refuses anything but a user, naming the scope', () => {
    expect(userActor(ctxOf({ type: 'user', id: 'u1' }), 'tenancy')).toEqual({
      type: 'user',
      id: 'u1',
    });
    expect(() => userActor(ctxOf(undefined), 'tenancy')).toThrow(
      'a user-initiated tenancy mutation ran without a principal',
    );
    expect(() =>
      userActor(ctxOf({ type: 'api_key', id: 'k' }), 'integrations'),
    ).toThrow(
      'a user-initiated integrations mutation ran with a api_key principal',
    );
  });
});
