import { describe, expect, it } from 'vitest';
import { endpointPathOf } from '../../../../src/modules/identity/infra/better-auth/auth-mount.middleware.js';

const BASE = '/api/auth';
const ORIGIN = 'http://localhost:3000';
/** Như mount: WHATWG URL giải `.`/`..` trước, rồi mới lấy path endpoint. */
const pathOf = (raw: string) =>
  endpointPathOf(new URL(raw, ORIGIN).pathname, BASE);

describe('endpointPathOf (carry-forward 3: the path given to mapAuthError)', () => {
  it.each([
    ['/api/auth/sign-in/email', '/sign-in/email'],
    ['/api/auth/change-password?x=1', '/change-password'],
    ['/api/auth/admin/ban-user', '/admin/ban-user'],
    ['/api/auth/x/../sign-out', '/sign-out'],
    ['/api/auth/x/%2e%2e/sign-out', '/sign-out'],
    ['/api/auth/./sign-out', '/sign-out'],
    // WHATWG URL không giải mã `%2F`/`%2D`; rou3 cũng không: path giữ dạng mã hoá, không bao giờ thành `/sign-out`
    // (better-call trả 404, mount không coi là đăng xuất).
    ['/api/auth/sign%2Dout', '/sign%2Dout'],
    ['/api/auth/sign-out%2Fx', '/sign-out%2Fx'],
    ['/api/auth/%2Fsign-out', '/%2Fsign-out'],
  ])('%s → %s', (raw, want) => expect(pathOf(raw)).toBe(want));

  it.each([
    '/api/auth/sign-out/',
    '/api/auth//sign-out',
    '/api/auth/admin//ban-user',
    '/API/AUTH/sign-out',
    '/api/auth',
    '/api/auth/',
    '/api/authx/sign-out',
    '/api/auth/../other',
  ])('%s is not canonical → undefined (mount answers 404)', (raw) =>
    expect(pathOf(raw)).toBeUndefined(),
  );
});
