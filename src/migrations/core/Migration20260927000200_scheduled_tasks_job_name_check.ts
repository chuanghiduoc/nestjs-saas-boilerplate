import { Migration } from '@mikro-orm/migrations';

/**
 * Follow-up chuẩn hoá SP1 (spec SP2 §10): `job_name` là định danh, không phải chuỗi tự do. Ép ĐỊNH DẠNG (đúng
 * NAME_PATTERN của defineJob); tập job hợp lệ do code quyết định lúc reconcile.
 *
 * Chuẩn hoá (Global Constraints — bảng phân tích của bảng bị sửa):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm / ghi chú | Dạng |
 * |---|---|---|---|
 * | scheduled_tasks | {id}, {org_id, key} | mọi cột phụ thuộc toàn bộ khoá; job_name là định danh (CHECK định dạng ở đây), timezone validate ở app (tập IANA đổi theo tzdata — ADR 0006) | BCNF |
 *
 * Khoá (review M7): migrator của SP1 chạy `transactional: true, allOrNothing: true` (src/core/database/migrator.ts),
 * nên `NOT VALID` + `VALIDATE` trong cùng transaction KHÔNG giảm khoá: ACCESS EXCLUSIVE giữ tới commit. Dùng một
 * `ADD CONSTRAINT … CHECK` (quét bảng dưới ACCESS EXCLUSIVE): `scheduled_tasks` là bảng cấu hình, mỗi lịch một dòng
 * (hàng trăm dòng) nên khoá ở mức mili giây. Bảng lớn thì phải tách: migration chỉ `ADD … NOT VALID`, còn
 * `VALIDATE CONSTRAINT` chạy ngoài migrator (runbook) vì `allOrNothing` gộp mọi migration đang chờ vào một transaction.
 */
export class Migration20260927000200_scheduled_tasks_job_name_check extends Migration {
  override name = 'Migration20260927000200_scheduled_tasks_job_name_check';

  override up(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_job_name_ck CHECK (job_name ~ '^[a-z][a-z0-9._-]*$');`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_job_name_ck;`,
    );
  }
}
