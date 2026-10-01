import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3C (spec SP3 §5.2 hàng notifications, §6.13 bảng 3C): hai template của thu nhận là DÒNG của bảng tra cứu
 * `email_templates` (FK từ `email_deliveries.template`), nên 3C ∥ 3D chỉ chèn dòng, không ghi đè nhau (INT2-N-3).
 * Không bảng mới, không đổi chuẩn hoá (`email_templates` BCNF, spec §6.12). Khoá: `ROW EXCLUSIVE` trên `email_templates`.
 * Down: xoá hai dòng; FK RESTRICT từ `email_deliveries` làm down fail to (`23001`) khi còn thư dùng key — runbook: chờ
 * cron dọn `NOTIFICATIONS_RETENTION_DAYS` hoặc xoá dòng thư đã ở trạng thái cuối. Không đọc bảng FORCE.
 */
export class Migration20261001090216_acquisition_templates extends Migration {
  override name = 'Migration20261001090216_acquisition_templates';

  override up(): void | Promise<void> {
    this.addSql(
      `INSERT INTO email_templates (key) VALUES ('org-invitation'), ('ownership-transfer-requested');`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `DELETE FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested');`,
    );
  }
}
