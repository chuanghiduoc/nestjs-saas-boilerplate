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

describe('public auth responses', () => {
  it('missing users and incorrect passwords produce identical public responses', () => {
    const codes = [
      'INVALID_EMAIL_OR_PASSWORD',
      'INVALID_PASSWORD',
      'USER_NOT_FOUND',
      'CREDENTIAL_ACCOUNT_NOT_FOUND',
      'INVALID_USER',
    ];
    const responses = codes.map((code) => {
      const body = problemBody(
        mapAuthError({ status: 400, code }, opts),
        {
          instance: '/api/auth/sign-in/email',
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
      expect(response).not.toHaveProperty('detail');
    }
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'treats inherited key %s as unknown',
    (code) => {
      expect(mapAuthError({ status: 404, code }, opts).error.code).toBe(
        'not_found',
      );
    },
  );

  it('503 overrides upstream codes and uses configured retry delay', () => {
    const error = mapAuthError(
      { status: 503, code: 'INVALID_PASSWORD', retryAfter: '42' },
      opts,
    );
    expect(error.error.code).toBe('service_unavailable');
    expect(error.opts).toEqual({
      headers: { 'Retry-After': '7' },
      expected: true,
    });
  });

  it('429 overrides upstream codes and omits missing retry delay', () => {
    const error = mapAuthError({ status: 429, code: 'INVALID_PASSWORD' }, opts);
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
  ])('%s → %s %s', (code, status, ours) => {
    const e = mapAuthError({ status: 400, code }, opts);
    expect({ status: e.error.status, code: e.error.code }).toEqual({
      status,
      code: ours,
    });
  });
  it('validation errors carry the field path, never Better Auth messages', () => {
    const e = mapAuthError({ status: 400, code: 'PASSWORD_TOO_SHORT' }, opts);
    expect(e.opts.fields).toEqual([
      {
        path: 'password',
        code: 'password_too_short',
        message: 'Password is too short',
      },
    ]);
    expect(e.opts.detail).toBeUndefined();
  });
  it('429 keeps Retry-After from X-Retry-After', () => {
    const e = mapAuthError(
      { status: 429, code: undefined, retryAfter: '42' },
      opts,
    );
    expect(e.error.code).toBe('rate_limited');
    expect(e.opts.headers).toEqual({ 'Retry-After': '42' });
  });
  it('status fallback for codes without a specific mapping, and for unknown codes', () => {
    expect(
      mapAuthError(
        { status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS' },
        opts,
      ).error.code,
    ).toBe('forbidden');
    expect(
      mapAuthError({ status: 404, code: 'SOMETHING_NEW' }, opts).error.code,
    ).toBe('not_found');
    expect(
      mapAuthError({ status: 500, code: undefined }, opts).error.code,
    ).toBe('internal_error');
  });
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
