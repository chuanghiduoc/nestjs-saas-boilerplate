import { HttpStatus } from '@nestjs/common';
import { PG } from '../../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  type ErrorCode,
  type FieldError,
} from '../../../../core/errors/index.js';
import { IdentityErrors } from '../../errors.js';

/** Mã của Better Auth + plugin đang bật → mã của mình (spec §5.5 quy tắc 1). */
export const AUTH_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  USER_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  CREDENTIAL_ACCOUNT_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_USER: IdentityErrors.INVALID_CREDENTIALS,
  EMAIL_NOT_VERIFIED: IdentityErrors.EMAIL_NOT_VERIFIED,
  BANNED_USER: IdentityErrors.ACCOUNT_DISABLED,
  USER_BANNED: IdentityErrors.ACCOUNT_DISABLED,
  SESSION_NOT_FRESH: IdentityErrors.REAUTHENTICATION_REQUIRED,
  INVALID_ORIGIN: IdentityErrors.ORIGIN_NOT_ALLOWED,
  MISSING_OR_NULL_ORIGIN: IdentityErrors.ORIGIN_NOT_ALLOWED,
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: IdentityErrors.ORIGIN_NOT_ALLOWED,
  INVALID_TOKEN: IdentityErrors.INVALID_OR_EXPIRED_TOKEN,
  TOKEN_EXPIRED: IdentityErrors.INVALID_OR_EXPIRED_TOKEN,
  INVALID_CODE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  INVALID_BACKUP_CODE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  OTP_HAS_EXPIRED: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  INVALID_TWO_FACTOR_COOKIE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: CoreErrors.RATE_LIMITED,
  ACCOUNT_TEMPORARILY_LOCKED: CoreErrors.RATE_LIMITED,
  RATE_LIMIT_EXCEEDED: CoreErrors.RATE_LIMITED,
  USAGE_EXCEEDED: CoreErrors.RATE_LIMITED,
  USER_ALREADY_EXISTS: IdentityErrors.EMAIL_TAKEN,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: IdentityErrors.EMAIL_TAKEN,
  SESSION_EXPIRED: CoreErrors.UNAUTHENTICATED,
  KEY_NOT_FOUND: CoreErrors.UNAUTHENTICATED,
  KEY_DISABLED: CoreErrors.UNAUTHENTICATED,
  KEY_EXPIRED: CoreErrors.UNAUTHENTICATED,
  INVALID_API_KEY: CoreErrors.UNAUTHENTICATED,
  UNAUTHORIZED_SESSION: CoreErrors.UNAUTHENTICATED,
  PASSWORD_TOO_SHORT: CoreErrors.VALIDATION_FAILED,
  PASSWORD_TOO_LONG: CoreErrors.VALIDATION_FAILED,
  INVALID_EMAIL: CoreErrors.VALIDATION_FAILED,
  VALIDATION_ERROR: CoreErrors.VALIDATION_FAILED,
  MISSING_FIELD: CoreErrors.VALIDATION_FAILED,
  FIELD_NOT_ALLOWED: CoreErrors.VALIDATION_FAILED,
  BODY_MUST_BE_AN_OBJECT: CoreErrors.VALIDATION_FAILED,
  INVALID_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_REDIRECT_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_ERROR_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_NEW_USER_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  CALLBACK_URL_REQUIRED: CoreErrors.VALIDATION_FAILED,
  INVALID_METADATA_TYPE: CoreErrors.VALIDATION_FAILED,
  EXPIRES_IN_IS_TOO_SMALL: CoreErrors.VALIDATION_FAILED,
  EXPIRES_IN_IS_TOO_LARGE: CoreErrors.VALIDATION_FAILED,
  INVALID_PREFIX_LENGTH: CoreErrors.VALIDATION_FAILED,
  INVALID_NAME_LENGTH: CoreErrors.VALIDATION_FAILED,
  NAME_REQUIRED: CoreErrors.VALIDATION_FAILED,
  INVALID_ROLE_TYPE: CoreErrors.VALIDATION_FAILED,
};

/** Quyết định tường minh: map theo status của Better Auth (spec §5.5 quy tắc 5). */
export const AUTH_CODES_BY_STATUS: readonly string[] = [
  'FAILED_TO_CREATE_USER',
  'FAILED_TO_CREATE_SESSION',
  'FAILED_TO_UPDATE_USER',
  'FAILED_TO_GET_SESSION',
  'SOCIAL_ACCOUNT_ALREADY_LINKED',
  'PROVIDER_NOT_FOUND',
  'ID_TOKEN_NOT_SUPPORTED',
  'FAILED_TO_GET_USER_INFO',
  'USER_EMAIL_NOT_FOUND',
  'EMAIL_CAN_NOT_BE_UPDATED',
  'CHANGE_EMAIL_DISABLED',
  'ACCOUNT_NOT_FOUND',
  'FAILED_TO_UNLINK_LAST_ACCOUNT',
  'USER_ALREADY_HAS_PASSWORD',
  'VERIFICATION_EMAIL_NOT_ENABLED',
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_MISMATCH',
  'LINKED_ACCOUNT_ALREADY_EXISTS',
  'FAILED_TO_CREATE_VERIFICATION',
  'ASYNC_VALIDATION_NOT_SUPPORTED',
  'METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED',
  'PASSWORD_ALREADY_SET',
  'OTP_NOT_ENABLED',
  'OTP_NOT_CONFIGURED',
  'TOTP_NOT_ENABLED',
  'TOTP_ALREADY_ENABLED',
  'TOTP_NOT_CONFIGURED',
  'TWO_FACTOR_NOT_ENABLED',
  'BACKUP_CODES_NOT_ENABLED',
  'REFILL_AMOUNT_AND_INTERVAL_REQUIRED',
  'REFILL_INTERVAL_AND_AMOUNT_REQUIRED',
  'KEY_NOT_RECOVERABLE',
  'INVALID_REMAINING',
  'METADATA_DISABLED',
  'NO_VALUES_TO_UPDATE',
  'KEY_DISABLED_EXPIRATION',
  'INVALID_USER_ID_FROM_API_KEY',
  'INVALID_REFERENCE_ID_FROM_API_KEY',
  'INVALID_API_KEY_GETTER_RETURN_TYPE',
  'SERVER_ONLY_PROPERTY',
  'FAILED_TO_UPDATE_API_KEY',
  'ORGANIZATION_ID_REQUIRED',
  'USER_NOT_MEMBER_OF_ORGANIZATION',
  'INSUFFICIENT_API_KEY_PERMISSIONS',
  'NO_DEFAULT_API_KEY_CONFIGURATION_FOUND',
  'ORGANIZATION_PLUGIN_REQUIRED',
  'YOU_CANNOT_BAN_YOURSELF',
  'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE',
  'YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS',
  'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS',
  'YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD',
  'YOU_ARE_NOT_ALLOWED_TO_GET_USER',
  'NO_DATA_TO_UPDATE',
  'YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS',
  'YOU_CANNOT_REMOVE_YOURSELF',
  'YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE',
  'YOU_CANNOT_IMPERSONATE_ADMINS',
  'YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL',
  'PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER',
  'INVALID_OAUTH_CONFIGURATION',
  'TOKEN_URL_NOT_FOUND',
];

const BY_STATUS: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: CoreErrors.MALFORMED_REQUEST,
  [HttpStatus.UNAUTHORIZED]: CoreErrors.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: CoreErrors.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: CoreErrors.NOT_FOUND,
  [HttpStatus.CONFLICT]: CoreErrors.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: CoreErrors.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: CoreErrors.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: CoreErrors.SERVICE_UNAVAILABLE,
};
/** Trường bị lỗi (spec §5.5 quy tắc 2); message cố định của mình, không chép message của Better Auth (quy tắc 6). */
const FIELD_OF: Readonly<Record<string, { path: string; message: string }>> = {
  PASSWORD_TOO_SHORT: { path: 'password', message: 'Password is too short' },
  PASSWORD_TOO_LONG: { path: 'password', message: 'Password is too long' },
  INVALID_EMAIL: { path: 'email', message: 'Email address is invalid' },
  INVALID_CALLBACK_URL: {
    path: 'callbackURL',
    message: 'URL is not a trusted origin',
  },
  INVALID_ERROR_CALLBACK_URL: {
    path: 'errorCallbackURL',
    message: 'URL is not a trusted origin',
  },
  INVALID_NEW_USER_CALLBACK_URL: {
    path: 'newUserCallbackURL',
    message: 'URL is not a trusted origin',
  },
  INVALID_REDIRECT_URL: {
    path: 'redirectTo',
    message: 'URL is not a trusted origin',
  },
  CALLBACK_URL_REQUIRED: { path: 'callbackURL', message: 'Required' },
};

export const authUnavailable = (retryAfterSec: number): AppError =>
  new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
    headers: { 'Retry-After': String(retryAfterSec) },
    expected: true,
  });

export function mapAuthError(
  input: { status: number; code?: string; retryAfter?: string | null },
  opts: { unavailableRetryAfterSec: number },
): AppError {
  if (input.status === HttpStatus.TOO_MANY_REQUESTS)
    return new AppError(
      CoreErrors.RATE_LIMITED,
      input.retryAfter ? { headers: { 'Retry-After': input.retryAfter } } : {},
    );
  if (input.status === HttpStatus.SERVICE_UNAVAILABLE)
    return authUnavailable(opts.unavailableRetryAfterSec);
  const mapped =
    input.code && Object.hasOwn(AUTH_CODE_MAP, input.code)
      ? AUTH_CODE_MAP[input.code]
      : undefined;
  if (mapped) {
    const field = input.code ? FIELD_OF[input.code] : undefined;
    const fields: FieldError[] | undefined =
      field && input.code
        ? [
            {
              path: field.path,
              code: input.code.toLowerCase(),
              message: field.message,
            },
          ]
        : undefined;
    return new AppError(mapped, fields ? { fields } : {});
  }
  return new AppError(BY_STATUS[input.status] ?? CoreErrors.INTERNAL_ERROR);
}

/** Lỗi hạ tầng của pool auth (spec §5.5 quy tắc 4) → 503, không bao giờ 500. */
const INFRA_SQLSTATE = /^(?:08|53)[0-9A-Z]{3}$|^57P0[123]$/;
const INFRA_TRANSACTION_CODES: readonly string[] = [
  PG.QUERY_CANCELED,
  PG.SERIALIZATION_FAILURE,
  PG.DEADLOCK_DETECTED,
];
const POOL_TIMEOUT = 'timeout exceeded when trying to connect';
const MAX_CAUSE_DEPTH = 5;
export function isAuthInfraError(err: unknown): boolean {
  for (
    let cur: unknown = err, depth = 0;
    cur && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    const code =
      typeof cur === 'object' && cur !== null && 'code' in cur
        ? cur.code
        : undefined;
    if (
      typeof code === 'string' &&
      (INFRA_SQLSTATE.test(code) || INFRA_TRANSACTION_CODES.includes(code))
    )
      return true;
    if (cur instanceof Error && cur.message.includes(POOL_TIMEOUT)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}
