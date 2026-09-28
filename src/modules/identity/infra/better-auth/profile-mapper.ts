import type { GoogleProfile } from 'better-auth/social-providers';
import { normalizeEmail } from './email-normalize.js';

/**
 * Better Auth liên kết khi provider "tin cậy" HOẶC gửi email_verified=true (A.3), nên không dùng
 * `trustedProviders` của nó; thay vào đó `mapProfileToUser` ghi đè `emailVerified` (A.3 xác nhận giá trị
 * của mapper thắng). Chỉ đúng `true` kiểu boolean từ provider nằm trong AUTH_TRUSTED_PROVIDERS mới tính.
 */
export const emailVerifiedFromProvider = (
  providerId: string,
  trusted: readonly string[],
  profile: Record<string, unknown>,
): boolean => trusted.includes(providerId) && profile.email_verified === true;

/**
 * AUTH final review concern 3: Better Auth tra user theo email của IdP (`oauth2/link-account.mjs:119`, chỉ
 * `toLowerCase()`) TRƯỚC khi `databaseHooks.user.create.before` chuẩn hoá email. Email có khoảng trắng/NFD thì không
 * khớp user đã có, lệnh tạo sau đó vướng `UNIQUE(email)` và đăng nhập thất bại. Chuẩn hoá ở mapper: kết quả của mapper
 * đè `email` của profile (`...userMap`/`...mapped`, `social-providers/google.mjs:124-131`,
 * `plugins/generic-oauth/index.mjs:229-236`) trước bước tra cứu. Claim không phải chuỗi thì để nguyên (Better Auth tự
 * báo thiếu email).
 */
const normalizedEmailClaim = (email: unknown): { email?: string } =>
  typeof email === 'string' ? { email: normalizeEmail(email) } : {};

export const GOOGLE_PROVIDER_ID = 'google';
/**
 * `GoogleProfile` là interface (không có index signature) nên không gán được cho `Record<string, unknown>`:
 * chỉ chuyển claim cần thiết. Kiểu tĩnh nói `boolean` nhưng giá trị đến từ IdP, nên vẫn kiểm `=== true`.
 */
export const googleProfileMapper =
  (trusted: readonly string[]) => (profile: GoogleProfile) => ({
    ...normalizedEmailClaim(profile.email),
    emailVerified: emailVerifiedFromProvider(GOOGLE_PROVIDER_ID, trusted, {
      email_verified: profile.email_verified,
    }),
  });
export const oidcProfileMapper =
  (providerId: string, trusted: readonly string[]) =>
  (profile: Record<string, unknown>) => ({
    ...normalizedEmailClaim(profile.email),
    emailVerified: emailVerifiedFromProvider(providerId, trusted, profile),
  });
