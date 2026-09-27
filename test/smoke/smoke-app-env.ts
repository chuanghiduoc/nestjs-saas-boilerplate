/** Service `mailpit` trong compose.yaml và cổng SMTP bên trong container của nó (STARTTLS ở smoke). */
const SMOKE_SMTP_HOST = 'mailpit';
const SMOKE_SMTP_PORT = '1025';
/** Người gửi test; có khoảng trắng và `<>` để kiểm luôn phần quote của file env. */
const SMOKE_MAIL_FROM = 'NSB Smoke <noreply@smoke.test>';

/**
 * Config production bổ sung của module cho container app (plan SP2: Task 43 thêm identity + notifications,
 * Task 46 thêm dashboard). Giá trị test, không phải default của app.
 * SMTP (Task 18): `.env.example` để trống SMTP_HOST/MAIL_FROM; worker cần cả hai. SMTP_REQUIRE_TLS và
 * SMTP_TLS_REJECT_UNAUTHORIZED giữ mặc định production (true): Mailpit bắt STARTTLS với chứng chỉ của CA
 * smoke, tin cậy qua NODE_EXTRA_CA_CERTS.
 */
export const smokeAppEnv = (_s: {
  secret: (bytes?: number) => string;
}): Record<string, string> => ({
  SMTP_HOST: SMOKE_SMTP_HOST,
  SMTP_PORT: SMOKE_SMTP_PORT,
  MAIL_FROM: SMOKE_MAIL_FROM,
});
