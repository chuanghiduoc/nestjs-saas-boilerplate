import { Migration } from '@mikro-orm/migrations';

/**
 * `public.email_deliveries` (spec SP2 §5.11). Bảng global (không org_id): email giao dịch của auth.
 *
 * Bảng chuẩn hoá (spec §5.16a, §5.16c):
 * | Khoá ứng viên | {id}, {public_id}, {idempotency_key} |
 * | Phụ thuộc hàm không tầm thường | mỗi khoá → mọi cột; idempotency_key → template (tiền tố); lease_owner (≠ NULL) là v7 duy nhất mỗi lần claim |
 * | Dạng chuẩn | BCNF: mọi vế trái là siêu khoá |
 * | Ngoại lệ có lý do | recipient_enc là snapshot bất biến (không phải bản sao auth."user".email); cơ chế: grant UPDATE theo cột |
 * | Tài liệu mờ | params_enc (JSON đã mã hoá, chỉ renderer đọc, xoá ở trạng thái cuối) |
 * | Enum | template, state, last_error_code: TEXT + CHECK; locale: CHECK định dạng, tập hợp do file template quyết định |
 * Thay đổi do chuẩn hoá: completed_at thay sent_at/failed_at; CHECK last_error_code; CHECK locale; CHECK tiền tố
 * idempotency_key; CHECK trạng thái cuối không còn params; UPDATE theo cột.
 *
 * Index: (created_at) WHERE cuối → cron dọn; (last_enqueued_at) WHERE PENDING/SENDING → cron đối soát + metric tồn đọng.
 */
export class Migration20260927145436_email_deliveries extends Migration {
  override name = 'Migration20260927145436_email_deliveries';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE email_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE,
    template TEXT NOT NULL CHECK (template IN ('verify-email', 'reset-password', 'two-factor-changed', 'existing-account')),
    locale TEXT NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
    recipient_enc TEXT NOT NULL,
    params_enc TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
    lease_owner UUID NULL,
    lease_until TIMESTAMPTZ NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    enqueue_generation INT NOT NULL DEFAULT 0 CHECK (enqueue_generation >= 0),
    last_enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error_code TEXT NULL CHECK (last_error_code IN ('SMTP_TRANSIENT', 'SMTP_PERMANENT', 'SMTP_TIMEOUT', 'SMTP_CONNECTION')),
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_deliveries_idempotency_prefix_ck CHECK (starts_with(idempotency_key, template || ':')),
    CONSTRAINT email_deliveries_lease_ck CHECK (
      (state = 'SENDING' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'SENDING' AND lease_owner IS NULL AND lease_until IS NULL)),
    CONSTRAINT email_deliveries_completed_ck CHECK ((state IN ('SENT', 'FAILED')) = (completed_at IS NOT NULL)),
    CONSTRAINT email_deliveries_final_params_ck CHECK (state NOT IN ('SENT', 'FAILED') OR params_enc IS NULL));`);
    this.addSql(
      `CREATE INDEX email_deliveries_purge_idx ON email_deliveries (created_at) WHERE state IN ('SENT', 'FAILED');`,
    );
    this.addSql(
      `CREATE INDEX email_deliveries_reconcile_idx ON email_deliveries (last_enqueued_at) WHERE state IN ('PENDING', 'SENDING');`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON email_deliveries TO app_user;`,
    );
    // Snapshot bất biến (public_id, template, locale, recipient_enc, idempotency_key, created_at): không ai sửa được.
    this.addSql(
      `GRANT UPDATE (params_enc, state, lease_owner, lease_until, attempts, enqueue_generation, last_enqueued_at, last_error_code, completed_at, updated_at) ON email_deliveries TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE email_deliveries;`);
  }
}
