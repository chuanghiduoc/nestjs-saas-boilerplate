import { AsyncLocalStorage } from 'node:async_hooks';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import { PublicRoute } from '../../../../src/core/http/index.js';
import { IdentityErrors } from '../../../../src/modules/identity/errors.js';
import { AuthGuard } from '../../../../src/modules/identity/http/auth.guard.js';
import { AuthState } from '../../../../src/modules/identity/http/auth-state.js';
import {
  RequireFreshSession,
  RequireVerifiedEmail,
} from '../../../../src/modules/identity/http/fresh-session.decorator.js';
import {
  identityConfig,
  identityGuardConfig,
} from '../../../../src/modules/identity/identity.config.js';
import type { AuthResult } from '../../../../src/modules/identity/ports/auth-provider.js';

const LOCAL = {
  AUTH_MODE: 'local',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  AUTH_BASE_URL: 'http://localhost:3000',
};
/** Mặc định `AUTH_SESSION_FRESH_AGE_SEC`. */
const FRESH_AGE_MS = 600_000;
/** Mặc định `AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC` (30 s). */
const CLOCK_TOLERANCE_MS = 30_000;
const NOW = new Date('2026-09-29T00:00:00Z');

@Controller('p')
class Probe {
  @RequireFreshSession()
  @Get('fresh')
  fresh(this: void) {
    return 1;
  }
  @RequireVerifiedEmail()
  @Get('verified')
  verified(this: void) {
    return 1;
  }
  @PublicRoute()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @Get('public-proof')
  publicProof(this: void) {
    return 1;
  }
}

const authed = (
  over: Partial<Extract<AuthResult, { kind: 'AUTHENTICATED' }>> = {},
): AuthResult => ({
  kind: 'AUTHENTICATED',
  principal: { type: 'user', id: 'u1' },
  credential: { kind: 'BEARER_SESSION' },
  isPlatformAdmin: false,
  authenticatedAt: NOW,
  emailVerified: true,
  verifiedEmail: 'u1@example.test',
  ...over,
});

describe('AuthGuard: @RequireFreshSession / @RequireVerifiedEmail fail closed (spec SP3 §5.2)', () => {
  let guard: AuthGuard;
  let cls: ClsService;
  let state: AuthState;
  beforeEach(() => {
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    cls = new ClsService(new AsyncLocalStorage());
    state = new AuthState(cls);
    guard = new AuthGuard(
      new Reflector(),
      state,
      identityGuardConfig(),
      identityConfig(),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const run = (r: AuthResult, handler: (this: void) => number) =>
    cls.run(() => {
      state.set(r);
      return guard.canActivate(new ExecutionContextHost([], Probe, handler));
    });

  it('ANONYMOUS and REJECTED never pass, even on a @PublicRoute()', () => {
    for (const h of [Probe.prototype.fresh, Probe.prototype.publicProof])
      expect(() => run({ kind: 'ANONYMOUS' }, h)).toThrow(
        expect.objectContaining({ error: CoreErrors.UNAUTHENTICATED }),
      );
    expect(() =>
      run({ kind: 'REJECTED' }, Probe.prototype.publicProof),
    ).toThrow(expect.objectContaining({ error: CoreErrors.UNAUTHENTICATED }));
  });
  it('@PublicRoute() does not waive the proof for an authenticated principal', () => {
    expect(() =>
      run(
        authed({ authenticatedAt: new Date(NOW.getTime() - FRESH_AGE_MS - 1) }),
        Probe.prototype.publicProof,
      ),
    ).toThrow(
      expect.objectContaining({
        error: IdentityErrors.REAUTHENTICATION_REQUIRED,
      }),
    );
    expect(() =>
      run(authed({ emailVerified: false }), Probe.prototype.publicProof),
    ).toThrow(
      expect.objectContaining({ error: IdentityErrors.EMAIL_NOT_VERIFIED }),
    );
  });
  it('an API key (no authenticatedAt, emailVerified false) is refused', () => {
    const key = authed({
      credential: { kind: 'API_KEY', id: 'k1' },
      authenticatedAt: undefined,
      emailVerified: false,
      verifiedEmail: undefined,
    });
    expect(() => run(key, Probe.prototype.fresh)).toThrow(
      expect.objectContaining({
        error: IdentityErrors.REAUTHENTICATION_REQUIRED,
      }),
    );
    expect(() => run(key, Probe.prototype.verified)).toThrow(
      expect.objectContaining({ error: IdentityErrors.EMAIL_NOT_VERIFIED }),
    );
  });
  it('a session exactly AUTH_SESSION_FRESH_AGE_SEC old is still fresh; one ms older is not', () => {
    expect(
      run(
        authed({ authenticatedAt: new Date(NOW.getTime() - FRESH_AGE_MS) }),
        Probe.prototype.fresh,
      ),
    ).toBe(true);
    expect(() =>
      run(
        authed({ authenticatedAt: new Date(NOW.getTime() - FRESH_AGE_MS - 1) }),
        Probe.prototype.fresh,
      ),
    ).toThrow(
      expect.objectContaining({
        error: IdentityErrors.REAUTHENTICATION_REQUIRED,
      }),
    );
  });
  it('an API key never counts as fresh, even if a port stamps authenticatedAt = now', () => {
    const key = authed({
      credential: { kind: 'API_KEY', id: 'k1' },
      authenticatedAt: NOW,
    });
    expect(() => run(key, Probe.prototype.fresh)).toThrow(
      expect.objectContaining({
        error: IdentityErrors.REAUTHENTICATION_REQUIRED,
      }),
    );
  });
  it('authenticatedAt in the future counts only within AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC', () => {
    expect(
      run(
        authed({
          authenticatedAt: new Date(NOW.getTime() + CLOCK_TOLERANCE_MS),
        }),
        Probe.prototype.fresh,
      ),
    ).toBe(true);
    expect(() =>
      run(
        authed({
          authenticatedAt: new Date(NOW.getTime() + CLOCK_TOLERANCE_MS + 1),
        }),
        Probe.prototype.fresh,
      ),
    ).toThrow(
      expect.objectContaining({
        error: IdentityErrors.REAUTHENTICATION_REQUIRED,
      }),
    );
  });
});
