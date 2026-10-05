import { describe, expect, it } from 'vitest';
import type { Credential } from '../../../../src/core/context/index.js';
import { decideStaffAccess } from '../../../../src/modules/identity/http/staff-access.js';
import type { AuthResult } from '../../../../src/modules/identity/ports/auth-provider.js';

const authed = (
  kind: Credential['kind'],
  isPlatformAdmin = true,
): AuthResult => ({
  kind: 'AUTHENTICATED',
  principal: { type: kind === 'ORG_API_KEY' ? 'api_key' : 'user', id: 'u' },
  credential: { kind },
  isPlatformAdmin,
  authenticatedAt: new Date(),
  emailVerified: true,
  verifiedEmail: 'u@example.test',
  sessionId:
    kind === 'SESSION_COOKIE' || kind === 'BEARER_SESSION' ? 's' : undefined,
});

/** Addendum A1.3 / PSA-1: bảng quyết định đầy đủ (AuthResult × credential × mode × dấu × auth_time). */
describe('decideStaffAccess', () => {
  it.each(['local', 'hybrid'] as const)(
    '%s session of staff: CHECK_TOTP_MARK, then ALLOW only with a fresh TOTP mark',
    (mode) => {
      for (const kind of ['SESSION_COOKIE', 'BEARER_SESSION'] as const) {
        expect(decideStaffAccess({ auth: authed(kind), mode })).toBe(
          'CHECK_TOTP_MARK',
        );
        expect(
          decideStaffAccess({ auth: authed(kind), mode, totpMarkFresh: true }),
        ).toBe('ALLOW');
        expect(
          decideStaffAccess({ auth: authed(kind), mode, totpMarkFresh: false }),
        ).toBe('SECOND_FACTOR_REQUIRED');
      }
    },
  );
  it('external: auth_time must be fresh; never a TOTP query', () => {
    for (const kind of ['EXTERNAL_COOKIE', 'EXTERNAL_BEARER'] as const) {
      expect(
        decideStaffAccess({
          auth: authed(kind),
          mode: 'external',
          authTimeFresh: true,
        }),
      ).toBe('ALLOW');
      expect(
        decideStaffAccess({
          auth: authed(kind),
          mode: 'external',
          authTimeFresh: false,
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
      expect(decideStaffAccess({ auth: authed(kind), mode: 'external' })).toBe(
        'REAUTHENTICATION_REQUIRED',
      );
    }
  });
  it.each(['API_KEY', 'ORG_API_KEY'] as const)(
    '%s is FORBIDDEN in every mode (second line of defence)',
    (kind) => {
      for (const mode of ['local', 'hybrid', 'external'] as const)
        expect(decideStaffAccess({ auth: authed(kind), mode })).toBe(
          'FORBIDDEN',
        );
    },
  );
  it('not staff → FORBIDDEN; no principal → UNAUTHENTICATED (fail closed, even on a public route)', () => {
    expect(
      decideStaffAccess({
        auth: authed('SESSION_COOKIE', false),
        mode: 'local',
      }),
    ).toBe('FORBIDDEN');
    for (const auth of [
      { kind: 'ANONYMOUS' },
      { kind: 'REJECTED' },
      { kind: 'EMAIL_NOT_VERIFIED' },
      { kind: 'UNAVAILABLE' },
    ] as const)
      expect(decideStaffAccess({ auth, mode: 'local' })).toBe(
        'UNAUTHENTICATED',
      );
  });
  it('a session credential in external mode or an external credential in local mode is FORBIDDEN (credential does not belong to the mode)', () => {
    expect(
      decideStaffAccess({ auth: authed('SESSION_COOKIE'), mode: 'external' }),
    ).toBe('FORBIDDEN');
    expect(
      decideStaffAccess({ auth: authed('EXTERNAL_BEARER'), mode: 'local' }),
    ).toBe('FORBIDDEN');
  });
});
