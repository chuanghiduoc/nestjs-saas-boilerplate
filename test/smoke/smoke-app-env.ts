/** Service `mailpit` trong compose.yaml và cổng SMTP bên trong container của nó (STARTTLS ở smoke). */
const SMOKE_SMTP_HOST = 'mailpit';
const SMOKE_SMTP_PORT = '1025';
/** Người gửi test; có khoảng trắng và `<>` để kiểm luôn phần quote của file env. */
const SMOKE_MAIL_FROM = 'NSB Smoke <noreply@smoke.test>';
/** Không có ingress TLS: smoke gọi thẳng cổng HTTP của api, base URL vẫn `https` như production (plan SP2). */
export const SMOKE_BASE_URL = 'https://localhost';
/** Byte ngẫu nhiên của BETTER_AUTH_SECRET (base64url ≥ 32 ký tự, đủ ký tự khác nhau cho luật production). */
const SMOKE_AUTH_SECRET_BYTES = 36;

/**
 * Config production bổ sung của module cho container app (plan SP2: Task 43 thêm identity + notifications,
 * Task 46 thêm dashboard). Giá trị test, không phải default của app.
 * SMTP (Task 18): `.env.example` để trống SMTP_HOST/MAIL_FROM; worker cần cả hai. SMTP_REQUIRE_TLS và
 * SMTP_TLS_REJECT_UNAUTHORIZED giữ mặc định production (true): Mailpit bắt STARTTLS với chứng chỉ của CA
 * smoke, tin cậy qua NODE_EXTRA_CA_CERTS.
 * Identity (Task 37 bật module trong `APP_MODULES`): hai khoá bắt buộc ở `AUTH_MODE=local` mà `.env.example`
 * không đánh dấu `(required)` (bắt buộc có điều kiện), nên preflight không bắt được.
 */
export const smokeAppEnv = (s: {
  secret: (bytes?: number) => string;
}): Record<string, string> => ({
  SMTP_HOST: SMOKE_SMTP_HOST,
  SMTP_PORT: SMOKE_SMTP_PORT,
  MAIL_FROM: SMOKE_MAIL_FROM,
  BETTER_AUTH_SECRET: s.secret(SMOKE_AUTH_SECRET_BYTES),
  AUTH_BASE_URL: SMOKE_BASE_URL,
});
