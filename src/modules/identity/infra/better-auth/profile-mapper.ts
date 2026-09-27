import type { GoogleProfile } from 'better-auth/social-providers';

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

export const GOOGLE_PROVIDER_ID = 'google';
/**
 * `GoogleProfile` là interface (không có index signature) nên không gán được cho `Record<string, unknown>`:
 * chỉ chuyển claim cần thiết. Kiểu tĩnh nói `boolean` nhưng giá trị đến từ IdP, nên vẫn kiểm `=== true`.
 */
export const googleProfileMapper =
  (trusted: readonly string[]) => (profile: GoogleProfile) => ({
    emailVerified: emailVerifiedFromProvider(GOOGLE_PROVIDER_ID, trusted, {
      email_verified: profile.email_verified,
    }),
  });
export const oidcProfileMapper =
  (providerId: string, trusted: readonly string[]) =>
  (profile: Record<string, unknown>) => ({
    emailVerified: emailVerifiedFromProvider(providerId, trusted, profile),
  });
