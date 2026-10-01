/** Không có ingress TLS: smoke gọi thẳng cổng HTTP của api, base URL vẫn `https` như production (plan SP2). */
export const SMOKE_BASE_URL = 'https://localhost';
/** Ngưỡng khoá tài khoản của smoke: nhỏ để test khoá (429) nhanh, vẫn là giá trị production hợp lệ. */
export const SMOKE_LOCKOUT_MAX = 3;
/**
 * Mức sàn chống dò email (S2-R58) của smoke: bằng mặc định của `.env.example`, ghi tường minh để test đo được
 * (luật production đòi > 0).
 */
export const SMOKE_ENUMERATION_FLOOR_MS = 300;
/** Byte ngẫu nhiên của BETTER_AUTH_SECRET (base64url ≥ 32 ký tự, đủ ký tự khác nhau cho luật production). */
const SMOKE_AUTH_SECRET_BYTES = 36;
/**
 * Một proxy tin cậy phía trước api (ingress terminate TLS, gắn `X-Forwarded-For`), như triển khai production thật.
 * Smoke đóng vai ingress đó: mỗi kịch bản gửi IP client riêng qua `X-Forwarded-For`, nên rate limit theo IP của
 * Better Auth (vd. `AUTH_EMAIL_RATE_MAX=3` / 5 phút) giữ nguyên giá trị production mà các kịch bản không dính nhau.
 * Mặc định `false` của `.env.example` sẽ gom mọi request của smoke vào đúng một IP (gateway của Docker).
 */
const SMOKE_TRUSTED_PROXY_HOPS = '1';

/**
 * Config production bổ sung của module cho container app (plan SP2 Task 43; Task 46 thêm dashboard). Giá trị test,
 * không phải default của app. Không khoá nào tắt luật production: https base URL, Secure cookie, rate limit bật,
 * mức sàn chống dò > 0, SMTP STARTTLS + verify chứng chỉ (Mailpit dùng chứng chỉ của CA smoke, tin cậy qua
 * NODE_EXTRA_CA_CERTS). SMTP_HOST/SMTP_PORT của worker nằm ở `compose.yaml` (chỉ worker gửi thư, spec §9).
 * Không liệt kê lại khoá có default: `buildSmokeEnv` đã lấy toàn bộ từ `.env.example` (Task 17).
 */
export const smokeAppEnv = (s: {
  secret: (bytes?: number) => string;
}): Record<string, string> => ({
  AUTH_MODE: 'local',
  BETTER_AUTH_SECRET: s.secret(SMOKE_AUTH_SECRET_BYTES),
  AUTH_BASE_URL: SMOKE_BASE_URL,
  AUTH_SECURE_COOKIES: 'true',
  HTTP_CORS_ORIGINS: SMOKE_BASE_URL,
  TENANCY_INVITATION_ACCEPT_URL: `${SMOKE_BASE_URL}/invitations/accept`,
  TENANCY_INVITE_LINK_JOIN_URL: `${SMOKE_BASE_URL}/join`,
  HTTP_TRUST_PROXY: SMOKE_TRUSTED_PROXY_HOPS,
  AUTH_LOCKOUT_MAX_FAILURES: String(SMOKE_LOCKOUT_MAX),
  AUTH_ENUMERATION_MIN_RESPONSE_MS: String(SMOKE_ENUMERATION_FLOOR_MS),
  SMTP_REQUIRE_TLS: 'true',
  SMTP_TLS_REJECT_UNAUTHORIZED: 'true',
  MAIL_FROM: 'Boilerplate <noreply@example.test>',
});
