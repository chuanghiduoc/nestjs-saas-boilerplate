import { Migration } from '@mikro-orm/migrations';

/**
 * Spec SP3 §5.2 hàng notifications, §6.13 bảng 3A (INT2-N-3, S3-A47): template là DÒNG của bảng tra cứu, không còn là
 * một `CHECK` danh sách đóng — plan 3C và 3D mỗi plan chèn dòng của mình nên merge song song không ghi đè nhau.
 * Luật enum của spec cha: "lookup table với FK hoặc CHECK".
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm | Dạng |
 * |---|---|---|---|
 * | email_templates | {key} | — (toàn khoá, cộng created_at/updated_at) | BCNF |
 * | email_deliveries | như SP2 | `template` nay là FK tới `email_templates(key)` | BCNF (không đổi) |
 *
 * Grant `app_user`: `SELECT` (FK không cần; để test đọc). Không RLS: bảng global (`GLOBAL_TABLES`).
 * Index: PK (đích FK). Khoá: `SHARE ROW EXCLUSIVE` trên `email_deliveries` khi thêm FK (quét kiểm dữ liệu), `ACCESS
 * EXCLUSIVE` ngắn khi bỏ CHECK; giữ tới hết lô 3A (`allOrNothing`).
 *
 * Down: thêm lại đúng `CHECK` của SP2 (kiểm dữ liệu: còn dòng template mới của 3C/3D thì fail to, tức down của plan
 * đó chưa chạy), bỏ FK, xoá bảng. Không đọc dữ liệu trên bảng FORCE nên không cần mẫu `NO FORCE`.
 */
export class Migration20260928183903_email_templates_lookup extends Migration {
  override name = 'Migration20260928183903_email_templates_lookup';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE email_templates (
    key TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_templates_key_ck CHECK (key ~ '^[a-z][a-z0-9-]{0,63}$'));`);
    this.addSql(
      `INSERT INTO email_templates (key) VALUES ('verify-email'), ('reset-password'), ('two-factor-changed'), ('existing-account'), ('change-email-confirmation');`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_template_fk FOREIGN KEY (template) REFERENCES email_templates (key) ON DELETE RESTRICT;`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_template_check;`,
    );
    this.addSql(`GRANT SELECT ON email_templates TO app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_template_check CHECK (template IN ('verify-email', 'reset-password', 'two-factor-changed', 'existing-account', 'change-email-confirmation'));`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_template_fk;`,
    );
    this.addSql(`DROP TABLE email_templates;`);
  }
}
