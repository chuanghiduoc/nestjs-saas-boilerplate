import { describe, expect, it } from 'vitest';
import { otherCookieVariant } from '../../../../src/modules/identity/infra/better-auth/sign-out.js';

describe('otherCookieVariant (S2-R50 I2: expire the name the client actually sent)', () => {
  it.each(['SameSite=None', 'samesite=none', 'Partitioned'])(
    'keeps Secure on the plain variant with %s',
    (attribute) => {
      expect(
        otherCookieVariant(`__Secure-a=; Max-Age=0; Secure; ${attribute}`),
      ).toBe(`a=; Max-Age=0; Secure; ${attribute}`);
    },
  );
  it('plain → __Secure- adds the mandatory Secure attribute', () => {
    expect(
      otherCookieVariant(
        'svc.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      ),
    ).toBe(
      '__Secure-svc.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
  });
  it('__Secure- → plain drops Secure and keeps Domain/Path', () => {
    expect(
      otherCookieVariant(
        '__Secure-svc.session_token=; Max-Age=0; Domain=lvh.test; Path=/; HttpOnly; Secure; SameSite=Lax',
      ),
    ).toBe(
      'svc.session_token=; Max-Age=0; Domain=lvh.test; Path=/; HttpOnly; SameSite=Lax',
    );
  });
  it('does not add Secure twice', () => {
    expect(otherCookieVariant('a=; Max-Age=0; Secure')).toBe(
      '__Secure-a=; Max-Age=0; Secure',
    );
  });
});
