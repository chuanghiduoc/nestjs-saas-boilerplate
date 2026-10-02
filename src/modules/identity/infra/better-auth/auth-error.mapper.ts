import { HttpStatus } from '@nestjs/common';
import {
  PG,
  isDbInfraError,
  isDbNoAnswerError,
} from '../../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  errorCodeForStatus,
  type ErrorCode,
  type FieldError,
} from '../../../../core/errors/index.js';
import { IdentityErrors } from '../../errors.js';

/**
 * Mã do CHÍNH hook của mình ném (`createSessionFence`, S2-R44 R2): session của lần đăng nhập OAuth bị xoá vì liên
 * kết provider đã bị đòi lại. Công khai là `401 unauthenticated` (đăng nhập lại), không phải `invalid_credentials`.
 */
export const OAUTH_SESSION_REVOKED = 'OAUTH_SESSION_REVOKED';
/** Mã do CHÍNH identity ném trong `databaseHooks.user.delete.before` và `onAPIError.onError` (nhánh đua, spec SP3 §9.6). */
export const USER_DELETION_BLOCKED_CODE = 'USER_DELETION_BLOCKED';
/** Mã do CHÍNH identity ném trong `databaseHooks`/hook của nhân viên (spec SP3 §9.7 (7), (9), 3D). */
export const SECOND_FACTOR_REQUIRED_CODE = 'SECOND_FACTOR_REQUIRED';
export const STAFF_PASSWORD_WRITE_FORBIDDEN_CODE =
  'STAFF_PASSWORD_WRITE_FORBIDDEN';
export const STAFF_SESSION_FENCED_CODE = 'STAFF_SESSION_FENCED';
/** 500 fail closed: handler ghi mật khẩu cho subject mà hook `before` không xác định (không cần mục trong map: status 500). */
export const PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE =
  'PASSWORD_WRITE_SUBJECT_UNRESOLVED';
/** Detail cố định cho mã của mình (quy tắc 6: không chép message của Better Auth). */
export const AUTH_CODE_DETAIL: Readonly<Record<string, string>> = {
  [USER_DELETION_BLOCKED_CODE]:
    'The account lost its sessions and password during a race with an organization change; see the runbook for a partially deleted account',
};

/**
 * Mã của Better Auth + plugin đang bật → mã của mình (spec §5.5 quy tắc 1). Với các mã phụ thuộc route
 * (`decideByRoute`), giá trị ở đây là mặc định cho luồng đăng nhập công khai và route không xác định.
 */
export const AUTH_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  USER_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  CREDENTIAL_ACCOUNT_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_USER: IdentityErrors.INVALID_OR_EXPIRED_TOKEN,
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
  SESSION_EXPIRED: IdentityErrors.REAUTHENTICATION_REQUIRED,
  KEY_NOT_FOUND: CoreErrors.UNAUTHENTICATED,
  KEY_DISABLED: CoreErrors.UNAUTHENTICATED,
  KEY_EXPIRED: CoreErrors.UNAUTHENTICATED,
  INVALID_API_KEY: CoreErrors.UNAUTHENTICATED,
  UNAUTHORIZED_SESSION: CoreErrors.UNAUTHENTICATED,
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
  [OAUTH_SESSION_REVOKED]: CoreErrors.UNAUTHENTICATED,
  [USER_DELETION_BLOCKED_CODE]: IdentityErrors.USER_DELETION_BLOCKED,
  [SECOND_FACTOR_REQUIRED_CODE]: IdentityErrors.SECOND_FACTOR_REQUIRED,
  [STAFF_PASSWORD_WRITE_FORBIDDEN_CODE]: CoreErrors.FORBIDDEN,
  [STAFF_SESSION_FENCED_CODE]: CoreErrors.UNAUTHENTICATED,
};

/** Mã chỉ được quyết định trong `decideByRoute` (với mọi path), không có mặc định trong `AUTH_CODE_MAP`. */
export const AUTH_ROUTE_DECIDED_CODES: readonly string[] = [
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
];

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

/** Trường bị lỗi (spec §5.5 quy tắc 2); message cố định của mình, không chép message của Better Auth (quy tắc 6). */
type Field = { path: string; message: string };
const FIELD_OF: Readonly<Record<string, Field>> = {
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

/**
 * Đầu vào của mapper. `path` là đường dẫn endpoint của Better Auth: pathname của request đã bỏ tiền tố
 * `AUTH_BASE_PATH` và query (vd. `/sign-in/email`, `/change-password`, `/admin/get-user`), đúng chuỗi
 * `createAuthEndpoint("<path>")` của Better Auth 1.7.6. `AuthMountMiddleware` (Task 36) bắt buộc truyền vào.
 */
export type AuthErrorInput = {
  status: number;
  code?: string | undefined;
  retryAfter?: string | null | undefined;
  path: string;
};

type Decision = { error: ErrorCode; field?: Field | undefined };

const SIGN_UP_PATH = '/sign-up/email';
const ADMIN_PREFIX = '/admin/';
const CHANGE_PASSWORD_PATH = '/change-password';
/** `USER_NOT_FOUND` sau khi token một lần đã hợp lệ (user bị xoá sau khi phát token): token không còn dùng được. */
const ONE_TIME_TOKEN_PATHS: readonly string[] = [
  '/reset-password',
  '/verify-email',
];
/**
 * Route đã xác thực xác minh lại mật khẩu trên `body.password` (update-user.mjs:286-290 delete-user,
 * password.mjs:197-200 verify-password, two-factor/index.mjs:108-112,211-215, totp/index.mjs:127-128,
 * backup-codes/index.mjs:280-281).
 */
const PASSWORD_RECHECK_PATHS: readonly string[] = [
  '/delete-user',
  '/verify-password',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
];
/** Route kiểm độ dài mật khẩu trên `body.newPassword` (password.mjs:152-153, update-user.mjs:162-163,200-201, admin/routes.mjs:828-829). */
const NEW_PASSWORD_PATHS: readonly string[] = [
  '/reset-password',
  CHANGE_PASSWORD_PATH,
  '/set-password',
  '/admin/set-user-password',
];

/**
 * Mã mà nghĩa phụ thuộc route (review I3, M5). `401 invalid_credentials` chống dò email chỉ áp dụng cho
 * xác minh credential ở luồng đăng nhập công khai; trên route đã xác thực, 401 làm client coi như mất session.
 * Trả `undefined` thì dùng bảng `AUTH_CODE_MAP`.
 */
function decideByRoute(code: string, path: string): Decision | undefined {
  switch (code) {
    case 'INVALID_PASSWORD':
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND': {
      // sign-up.mjs:152: thiếu password trong body, không phải sai mật khẩu.
      if (path === SIGN_UP_PATH)
        return {
          error: CoreErrors.VALIDATION_FAILED,
          field: { path: 'password', message: 'Required' },
        };
      // Chỉ route đã xác thực được liệt kê tường minh mới thoát khỏi mặc định chống dò email: path lạ
      // (sign-in, path chưa chuẩn hoá, route mới) rơi về `401 invalid_credentials` như USER_NOT_FOUND.
      if (
        path !== CHANGE_PASSWORD_PATH &&
        !PASSWORD_RECHECK_PATHS.includes(path)
      )
        return undefined;
      return {
        error: CoreErrors.VALIDATION_FAILED,
        field: {
          path: path === CHANGE_PASSWORD_PATH ? 'currentPassword' : 'password',
          message:
            code === 'INVALID_PASSWORD'
              ? 'Password is incorrect'
              : 'No password is set for this account',
        },
      };
    }
    case 'USER_NOT_FOUND':
      // admin/routes.mjs: user đích không tồn tại (404), không liên quan tới credential của admin.
      if (path.startsWith(ADMIN_PREFIX)) return { error: CoreErrors.NOT_FOUND };
      if (ONE_TIME_TOKEN_PATHS.includes(path))
        return { error: IdentityErrors.INVALID_OR_EXPIRED_TOKEN };
      return undefined;
    // Luôn quyết định ở đây (mọi route), nên không có mục trong AUTH_CODE_MAP.
    case 'PASSWORD_TOO_SHORT':
    case 'PASSWORD_TOO_LONG':
      // update-user.mjs:163-164 ném PASSWORD_TOO_LONG cho cả newPassword lẫn currentPassword: không đoán trường.
      if (code === 'PASSWORD_TOO_LONG' && path === CHANGE_PASSWORD_PATH)
        return { error: CoreErrors.VALIDATION_FAILED };
      return {
        error: CoreErrors.VALIDATION_FAILED,
        field: {
          path: NEW_PASSWORD_PATHS.includes(path) ? 'newPassword' : 'password',
          message:
            code === 'PASSWORD_TOO_SHORT'
              ? 'Password is too short'
              : 'Password is too long',
        },
      };
    default:
      return undefined;
  }
}

function decide(code: string, path: string): Decision | undefined {
  const byRoute = decideByRoute(code, path);
  if (byRoute) return byRoute;
  const error = Object.hasOwn(AUTH_CODE_MAP, code)
    ? AUTH_CODE_MAP[code]
    : undefined;
  return error ? { error, field: FIELD_OF[code] } : undefined;
}

export const authUnavailable = (retryAfterSec: number): AppError =>
  new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
    headers: { 'Retry-After': String(retryAfterSec) },
    expected: true,
  });

export function mapAuthError(
  input: AuthErrorInput,
  opts: { unavailableRetryAfterSec: number },
): AppError {
  if (input.status === HttpStatus.TOO_MANY_REQUESTS)
    return new AppError(
      CoreErrors.RATE_LIMITED,
      input.retryAfter ? { headers: { 'Retry-After': input.retryAfter } } : {},
    );
  if (input.status === HttpStatus.SERVICE_UNAVAILABLE)
    return authUnavailable(opts.unavailableRetryAfterSec);
  const decision = input.code ? decide(input.code, input.path) : undefined;
  if (decision && input.code) {
    const fields: FieldError[] | undefined = decision.field
      ? [
          {
            path: decision.field.path,
            code: input.code.toLowerCase(),
            message: decision.field.message,
          },
        ]
      : undefined;
    const detail = Object.hasOwn(AUTH_CODE_DETAIL, input.code)
      ? AUTH_CODE_DETAIL[input.code]
      : undefined;
    return new AppError(decision.error, {
      ...(fields ? { fields } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  // Spec §5.5 quy tắc 5: theo bảng status của core (gồm 405/413/415 mà better-call trả).
  return new AppError(
    errorCodeForStatus(input.status) ?? CoreErrors.INTERNAL_ERROR,
  );
}

/**
 * Lỗi hạ tầng của pool auth (spec §5.5 quy tắc 4) → 503, không bao giờ 500. S2-R70: danh sách SQLSTATE (08*, 53*,
 * 57P01-03, 57014), mã socket và message mất kết nối / hạn phía client của pg nằm ở MỘT chỗ, `isDbInfraError` của core.
 * Identity chỉ thêm hai điều riêng:
 * - 40001/40P01 (spec §5.5 quy tắc 4: "hết lượt retry"): core coi là lỗi retry được của transaction
 *   (`isRetryableTxError`), còn Better Auth không retry, nên với pool auth chúng là "DB không dùng được lúc này".
 * - Đi qua MỌI mắt xích `cause` (kể cả lớp bọc không mang dạng DB như lỗi của Better Auth hay object trần): core dừng ở
 *   mắt xích đầu tiên không mang dạng DB vì mapper của nó đăng ký toàn cục.
 */
const RETRY_EXHAUSTED_CODES: readonly string[] = [
  PG.SERIALIZATION_FAILURE,
  PG.DEADLOCK_DETECTED,
];
const MAX_CAUSE_DEPTH = 5;
const codeOf = (v: unknown): unknown =>
  typeof v === 'object' && v !== null && 'code' in v ? v.code : undefined;

/**
 * `Error` TRẦN của pg/pg-pool (không phải lớp con, không `code`, không `cause`) mà `isDbNoAnswerError` của core nhận ra
 * bằng message cố định của pg ("Connection terminated", "is not queryable", "Query read timeout", hết chờ pool). Dùng
 * để nhận ra lỗi xuất phát từ chính pool pg (review M2 của S2-R65), khác lỗi của Redis hay của MikroORM (lớp riêng) và
 * khác lỗi socket trần của Node (có `code`, không quy được nguồn: review N1).
 */
export function isPgClientInfraError(err: unknown): boolean {
  return (
    err instanceof Error &&
    Object.getPrototypeOf(err) === Error.prototype &&
    codeOf(err) === undefined &&
    err.cause === undefined &&
    isDbNoAnswerError(err)
  );
}

export function isAuthInfraError(err: unknown): boolean {
  for (
    let cur: unknown = err, depth = 0;
    cur && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    const code = codeOf(cur);
    if (typeof code === 'string' && RETRY_EXHAUSTED_CODES.includes(code))
      return true;
    if (isDbInfraError(cur)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}
