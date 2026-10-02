import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthFacts } from '../../../../src/modules/identity/http/auth-facts.js';
import { AuthState } from '../../../../src/modules/identity/http/auth-state.js';
import { StaffStepUp } from '../../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import type { AuthResult } from '../../../../src/modules/identity/ports/auth-provider.js';

const SESSION: AuthResult = {
  kind: 'AUTHENTICATED',
  principal: { type: 'user', id: 'u1' },
  credential: { kind: 'BEARER_SESSION' },
  isPlatformAdmin: true,
  authenticatedAt: new Date('2026-10-01T00:00:00Z'),
  emailVerified: true,
  verifiedEmail: 'u1@example.test',
  sessionId: 's1',
};

/** Spec SP3 §5.2 hàng `AuthFacts` (3D): `secondFactorVerifiedAt()` đọc lười, cache trong CLS, fail closed. */
describe('AuthFacts.secondFactorVerifiedAt', () => {
  // `pg.Pool` không mở kết nối khi chưa có query; câu duy nhất (`anyMarkVerifiedAt`) bị spy nên không chạm mạng.
  const pool = new pg.Pool();
  afterAll(async () => pool.end());
  const setup = (stepUp?: StaffStepUp) => {
    const cls = new ClsService(new AsyncLocalStorage());
    const state = new AuthState(cls);
    return { cls, state, facts: new AuthFacts(state, cls, stepUp) };
  };

  it('without StaffStepUp (external mode) it is undefined', async () => {
    const { cls, state, facts } = setup();
    await cls.run(async () => {
      state.set(SESSION);
      expect(await facts.secondFactorVerifiedAt()).toBeUndefined();
    });
  });
  it('reads the mark once per request (CLS cache), for the session of the principal', async () => {
    const at = new Date('2026-10-02T00:00:00Z');
    const stepUp = new StaffStepUp(pool);
    const read = vi.spyOn(stepUp, 'anyMarkVerifiedAt').mockResolvedValue(at);
    const { cls, state, facts } = setup(stepUp);
    await cls.run(async () => {
      state.set(SESSION);
      expect(await facts.secondFactorVerifiedAt()).toBe(at);
      expect(await facts.secondFactorVerifiedAt()).toBe(at);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('s1', 'u1');
  });
});
