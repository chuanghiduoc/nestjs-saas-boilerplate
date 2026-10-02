import { HttpStatus } from '@nestjs/common';
import { defineErrorCodes } from '../../core/errors/index.js';

export const IdentityErrors = defineErrorCodes({
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid email or password',
  },
  INVALID_TWO_FACTOR_CODE: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid two-factor code',
  },
  EMAIL_NOT_VERIFIED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Email address is not verified',
  },
  ACCOUNT_DISABLED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Account is disabled',
  },
  REAUTHENTICATION_REQUIRED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Sign in again to continue',
  },
  ORIGIN_NOT_ALLOWED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Request origin is not allowed',
  },
  AMBIGUOUS_CREDENTIALS: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Request carries more than one credential',
  },
  INVALID_OR_EXPIRED_TOKEN: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Link is invalid, expired or already used',
  },
  /** `POST {basePath}/sign-out` chỉ mang API key: API key không có session để đăng xuất (S2-R50 M3). */
  API_KEY_NOT_ACCEPTED: {
    status: HttpStatus.BAD_REQUEST,
    title: 'API keys cannot be used on this endpoint',
  },
  EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    title: 'Email address is already in use',
  },
  /** Spec SP3 §9.6, §15: identity sở hữu mã (identity không import tenancy); `last_owner` của tenancy chỉ ở route tenancy. */
  USER_DELETION_BLOCKED: {
    status: HttpStatus.CONFLICT,
    title: 'The account is the only owner of an active organization',
  },
  /**
   * Spec SP3 §9.7, §15 (3D): session của nhân viên thiếu dấu step-up hợp lệ (gate quyền nền tảng: dấu TOTP tươi; support
   * grant: dấu TOTP hoặc backup code không cũ hơn `TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC`); nhân viên chưa có factor đổi
   * mật khẩu / tạo credential mới. Identity sở hữu; tenancy dùng lại ở nhánh support grant.
   */
  SECOND_FACTOR_REQUIRED: {
    status: HttpStatus.FORBIDDEN,
    title: 'A recent two-factor step-up in this session is required',
  },
  /** Spec SP3 §9.7 (8) (3D, r6 N6-5): admin nền tảng cuối cùng chưa bị ban bỏ role admin của chính mình. */
  LAST_PLATFORM_ADMIN: {
    status: HttpStatus.CONFLICT,
    title: 'The last platform admin cannot drop their own admin role',
  },
  /**
   * Spec SP3 §15 (3D): org API key trên route không cho nó. Identity sở hữu (lệch có chủ đích với cột "Chủ" của spec):
   * `AuthGuard` (nhánh `@SessionOnly`) và `OrgApiKeyConfinementGuard` của tenancy đều từ chối và thứ tự APP_GUARD giữa
   * module không được bảo đảm, nên hai guard phải trả CÙNG một mã.
   */
  API_KEY_NOT_ALLOWED_HERE: {
    status: HttpStatus.FORBIDDEN,
    title: 'This API key cannot be used on this route',
  },
});
