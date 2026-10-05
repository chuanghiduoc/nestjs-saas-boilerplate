import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng notifications, §6.13 bảng 3D): template `support-access-notice` là DÒNG của bảng tra cứu
 * `email_templates` (3C ∥ 3D chỉ chèn dòng, INT2-N-3). Không bảng mới, không đổi chuẩn hoá. Khoá: `ROW EXCLUSIVE`.
 * Down: xoá dòng; FK RESTRICT từ `email_deliveries` làm down fail to (`23001`) khi còn thư dùng key — runbook như 3C.
 */
export class Migration20261004143813_support_templates extends Migration {
  override name = 'Migration20261004143813_support_templates';

  override up(): void | Promise<void> {
    this.addSql(
      `INSERT INTO email_templates (key) VALUES ('support-access-notice');`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `DELETE FROM email_templates WHERE key = 'support-access-notice';`,
    );
  }
}
