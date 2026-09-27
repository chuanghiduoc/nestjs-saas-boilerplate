import { API_KEY_ERROR_CODES } from '@better-auth/api-key';
import { BASE_ERROR_CODES } from 'better-auth';
import {
  TWO_FACTOR_ERROR_CODES,
  admin,
  genericOAuth,
} from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { problemBody } from '../../../../src/core/errors/index.js';
import {
  AUTH_CODES_BY_STATUS,
  AUTH_CODE_MAP,
  isAuthInfraError,
  mapAuthError,
} from '../../../../src/modules/identity/infra/better-auth/auth-error.mapper.js';

const allCodes = [
  ...Object.keys(BASE_ERROR_CODES),
  ...Object.keys(TWO_FACTOR_ERROR_CODES),
  ...Object.keys(API_KEY_ERROR_CODES),
  ...Object.keys(admin().$ERROR_CODES),
  ...Object.keys(genericOAuth({ config: [] }).$ERROR_CODES),
];
const opts = { unavailableRetryAfterSec: 7 };
const SIGN_IN = '/sign-in/email';
const mapped = (status: number, code: string | undefined, path: string) => {
  const e = mapAuthError({ status, code, path }, opts);
  return { status: e.error.status, code: e.error.code, fields: e.opts.fields };
};

describe('public auth responses', () => {
  it('missing users and incorrect passwords produce identical public sign-in responses', () => {
    const cases: [number, string][] = [
      [401, 'INVALID_EMAIL_OR_PASSWORD'],
      [400, 'INVALID_PASSWORD'],
      [400, 'USER_NOT_FOUND'],
      [400, 'CREDENTIAL_ACCOUNT_NOT_FOUND'],
    ];
    const responses = cases.map(([status, code]) => {
      const body = problemBody(
        mapAuthError({ status, code, path: SIGN_IN }, opts),
        {
          instance: `/api/auth${SIGN_IN}`,
          requestId: 'test',
          typeBase: '/errors',
        },
        true,
      );
      delete body.timestamp;
      return body;
    });
    for (const response of responses) {
      expect(response).toEqual(responses[0]);
      expect(response).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
      });
      expect(response).not.toHaveProperty('detail');
      expect(response).not.toHaveProperty('errors');
    }
  });

  it.each(['/sign-in/username', '/some-future-public-route'])(
    'USER_NOT_FOUND on non-admin route %s stays invalid_credentials (anti-enumeration default)',
    (path) => {
      expect(mapped(400, 'USER_NOT_FOUND', path).code).toBe(
        'invalid_credentials',
      );
    },
  );

  it.each(['constructor', '__proto__', 'toString'])(
    'treats inherited key %s as unknown',
    (code) => {
      expect(mapped(404, code, SIGN_IN).code).toBe('not_found');
    },
  );

  it('503 overrides upstream codes and uses configured retry delay', () => {
    const error = mapAuthError(
      {
        status: 503,
        code: 'INVALID_PASSWORD',
        retryAfter: '42',
        path: SIGN_IN,
      },
      opts,
    );
    expect(error.error.code).toBe('service_unavailable');
    expect(error.opts).toEqual({
      headers: { 'Retry-After': '7' },
      expected: true,
    });
  });

  it('429 overrides upstream codes and omits missing retry delay', () => {
    const error = mapAuthError(
      { status: 429, code: 'INVALID_PASSWORD', path: SIGN_IN },
      opts,
    );
    expect(error.error.code).toBe('rate_limited');
    expect(error.opts.headers).toBeUndefined();
  });

  it.each([{ code: '42P01' }, { code: '42501' }, null, undefined, '08006'])(
    'does not widen the infrastructure mapping for %j',
    (error) => {
      expect(isAuthInfraError(error)).toBe(false);
    },
  );

  it('recognizes wrapped infrastructure errors and terminates cause cycles', () => {
    expect(
      isAuthInfraError(new Error('wrapped', { cause: { code: '40P01' } })),
    ).toBe(true);
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    expect(isAuthInfraError(cyclic)).toBe(false);
  });
});

describe('authenticated and admin routes never answer 401 invalid_credentials', () => {
  it('a wrong current password on change-password is a validation problem on currentPassword', () => {
    expect(mapped(400, 'INVALID_PASSWORD', '/change-password')).toEqual({
      status: 422,
      code: 'validation_failed',
      fields: [
        {
          path: 'currentPassword',
          code: 'invalid_password',
          message: 'Password is incorrect',
        },
      ],
    });
  });
  it('an account without a password on change-password is a validation problem on currentPassword', () => {
    expect(
      mapped(400, 'CREDENTIAL_ACCOUNT_NOT_FOUND', '/change-password'),
    ).toEqual({
      status: 422,
      code: 'validation_failed',
      fields: [
        {
          path: 'currentPassword',
          code: 'credential_account_not_found',
          message: 'No password is set for this account',
        },
      ],
    });
  });
  it.each([
    '/delete-user',
    '/verify-password',
    '/two-factor/enable',
    '/two-factor/disable',
    '/two-factor/get-totp-uri',
    '/two-factor/generate-backup-codes',
  ])(
    'a wrong password re-check on %s is a validation problem on password',
    (path) => {
      expect(mapped(400, 'INVALID_PASSWORD', path)).toMatchObject({
        status: 422,
        code: 'validation_failed',
        fields: [{ path: 'password', code: 'invalid_password' }],
      });
    },
  );
  it('a missing password on sign-up is a validation problem on password', () => {
    expect(mapped(400, 'INVALID_PASSWORD', '/sign-up/email')).toMatchObject({
      status: 422,
      fields: [{ path: 'password' }],
    });
  });
  it.each([
    '/admin/get-user',
    '/admin/ban-user',
    '/admin/set-user-password',
    '/admin/impersonate-user',
  ])('USER_NOT_FOUND on %s is 404 not_found', (path) => {
    expect(mapped(404, 'USER_NOT_FOUND', path)).toEqual({
      status: 404,
      code: 'not_found',
      fields: undefined,
    });
  });
  it.each(['/reset-password', '/verify-email'])(
    'USER_NOT_FOUND behind a one-time token on %s means the token is no longer valid',
    (path) => {
      expect(mapped(400, 'USER_NOT_FOUND', path).code).toBe(
        'invalid_or_expired_token',
      );
    },
  );
  it('INVALID_USER (verify-email link of another signed-in user) is an invalid token, not 401', () => {
    expect(mapped(401, 'INVALID_USER', '/verify-email')).toMatchObject({
      status: 400,
      code: 'invalid_or_expired_token',
    });
  });
  it('SESSION_EXPIRED (delete-user freshness check) requires re-authentication', () => {
    expect(mapped(400, 'SESSION_EXPIRED', '/delete-user')).toMatchObject({
      status: 403,
      code: 'reauthentication_required',
    });
  });
});

describe('mapAuthError', () => {
  it('every Better Auth code of every enabled plugin has an explicit decision', () => {
    const decided = new Set([
      ...Object.keys(AUTH_CODE_MAP),
      ...AUTH_CODES_BY_STATUS,
    ]);
    expect([...new Set(allCodes)].filter((c) => !decided.has(c))).toEqual([]);
    expect(
      Object.keys(AUTH_CODE_MAP).filter((c) =>
        AUTH_CODES_BY_STATUS.includes(c),
      ),
    ).toEqual([]);
  });
  it.each([
    ['INVALID_EMAIL_OR_PASSWORD', 401, 'invalid_credentials'],
    ['USER_NOT_FOUND', 401, 'invalid_credentials'],
    ['EMAIL_NOT_VERIFIED', 403, 'email_not_verified'],
    ['BANNED_USER', 403, 'account_disabled'],
    ['SESSION_NOT_FRESH', 403, 'reauthentication_required'],
    ['INVALID_ORIGIN', 403, 'origin_not_allowed'],
    ['INVALID_TOKEN', 400, 'invalid_or_expired_token'],
    ['TOKEN_EXPIRED', 400, 'invalid_or_expired_token'],
    ['INVALID_CODE', 401, 'invalid_two_factor_code'],
    ['INVALID_BACKUP_CODE', 401, 'invalid_two_factor_code'],
    ['USER_ALREADY_EXISTS', 409, 'email_taken'],
    ['INVALID_CALLBACK_URL', 422, 'validation_failed'],
    ['PASSWORD_TOO_SHORT', 422, 'validation_failed'],
  ])('%s on sign-in → %s %s', (code, status, ours) => {
    const e = mapped(400, code, SIGN_IN);
    expect({ status: e.status, code: e.code }).toEqual({ status, code: ours });
  });
  it.each([
    ['/sign-up/email', 'PASSWORD_TOO_SHORT', 'password'],
    ['/sign-up/email', 'PASSWORD_TOO_LONG', 'password'],
    ['/sign-in/email', 'PASSWORD_TOO_LONG', 'password'],
    ['/reset-password', 'PASSWORD_TOO_SHORT', 'newPassword'],
    ['/reset-password', 'PASSWORD_TOO_LONG', 'newPassword'],
    ['/change-password', 'PASSWORD_TOO_SHORT', 'newPassword'],
    ['/set-password', 'PASSWORD_TOO_LONG', 'newPassword'],
    ['/admin/set-user-password', 'PASSWORD_TOO_SHORT', 'newPassword'],
    ['/admin/create-user', 'PASSWORD_TOO_LONG', 'password'],
  ])('%s %s points at the %s field', (path, code, field) => {
    expect(mapped(400, code, path)).toEqual({
      status: 422,
      code: 'validation_failed',
      fields: [
        {
          path: field,
          code: code.toLowerCase(),
          message:
            code === 'PASSWORD_TOO_SHORT'
              ? 'Password is too short'
              : 'Password is too long',
        },
      ],
    });
  });
  it('PASSWORD_TOO_LONG on change-password names no field: Better Auth raises it for newPassword or currentPassword', () => {
    expect(mapped(400, 'PASSWORD_TOO_LONG', '/change-password')).toEqual({
      status: 422,
      code: 'validation_failed',
      fields: undefined,
    });
  });
  it('validation errors never carry Better Auth messages', () => {
    const e = mapAuthError(
      { status: 400, code: 'PASSWORD_TOO_SHORT', path: '/sign-up/email' },
      opts,
    );
    expect(e.opts.detail).toBeUndefined();
  });
  it('429 keeps Retry-After from X-Retry-After', () => {
    const e = mapAuthError(
      { status: 429, code: undefined, retryAfter: '42', path: SIGN_IN },
      opts,
    );
    expect(e.error.code).toBe('rate_limited');
    expect(e.opts.headers).toEqual({ 'Retry-After': '42' });
  });
  it('status fallback for codes without a specific mapping, and for unknown codes', () => {
    expect(
      mapped(403, 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS', '/admin/list-users')
        .code,
    ).toBe('forbidden');
    expect(mapped(404, 'SOMETHING_NEW', SIGN_IN).code).toBe('not_found');
    expect(mapped(500, undefined, SIGN_IN).code).toBe('internal_error');
  });
  it.each([
    [405, 'method_not_allowed'],
    [413, 'payload_too_large'],
    [415, 'unsupported_media_type'],
    [422, 'validation_failed'],
    [400, 'malformed_request'],
    [401, 'unauthenticated'],
    [409, 'conflict'],
  ])(
    'status %s without a mapped code → %s (core status table)',
    (status, ours) => {
      expect(mapped(status, 'UNSUPPORTED_MEDIA_TYPE', SIGN_IN)).toMatchObject({
        status,
        code: ours,
      });
    },
  );
  it.each([
    [{ code: '08006' }, true],
    [{ code: '53300' }, true],
    [{ code: '57P01' }, true],
    [{ code: '57014' }, true],
    [{ code: '40001' }, true],
    [new Error('timeout exceeded when trying to connect'), true],
    [{ code: '23505' }, false],
    [new Error('boom'), false],
  ])('isAuthInfraError(%j) → %s', (err, want) =>
    expect(isAuthInfraError(err)).toBe(want),
  );
});
