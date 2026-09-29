import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3A (spec SP3 §6.13 bảng 3A, §9.4, T-32, DB2-N5, S3-A46).
 * - FK `scheduled_tasks.org_id → organizations(id) ON DELETE RESTRICT` (quy ước B5): xoá cứng org thiếu bước xoá lịch thì
 *   fail to (`23001`); participant `core.scheduled-tasks` (Task 25) xoá chúng trước. FK dùng index UNIQUE (org_id, key)
 *   có sẵn (cột đầu là org_id) cho kiểm RESTRICT.
 * - Trigger `BEFORE INSERT` khoá dòng org `FOR SHARE` (không `FOR KEY SHARE`: chỉ `FOR SHARE` xung đột với `FOR NO KEY
 *   UPDATE` của xoá mềm/khôi phục), nên INSERT lịch song song với xoá mềm chờ xoá mềm commit rồi thấy `deleted_at`
 *   (READ COMMITTED: câu khoá trả phiên bản đã commit mới nhất) và tự treo. Nhánh `ON CONFLICT DO UPDATE` của `upsert`
 *   không ghi `suspended_at`: giá trị do trigger đặt trên hàng đề xuất bị bỏ, dòng cũ giữ trạng thái của nó.
 * Chạy dưới app_user trong OrgScope (`WITH CHECK` đã buộc `NEW.org_id` = org hiện tại); `FOR SHARE` cần UPDATE một cột
 * của `organizations` (đã có).
 * Vì sao KHÔNG `SECURITY DEFINER` như ba trigger hoãn của `tenancy_core` (bài học Task 13): trigger này không hoãn, nó
 * chạy trong chính câu INSERT, cùng `app.org_id` với `WITH CHECK (org_id = app_current_org())` của `scheduled_tasks`.
 * Org của dòng mới thấy được qua policy `organizations_tenant` đúng khi `NEW.org_id = app_current_org()`, tức đúng khi
 * `WITH CHECK` đạt; context khác thì câu INSERT bị từ chối (42501), nên đổi `app.org_id` giữa transaction không tạo được
 * lịch chưa treo cho org xoá mềm (test `schedules-soft-delete.spec.ts`). Ngược lại, dưới `tenancy_definer` câu `FOR SHARE`
 * fail 42501 (role đó chỉ có SELECT theo cột), nên bản definer sẽ phải bỏ khoá dòng và mất tuần tự hoá với xoá mềm.
 *
 * Bảng chuẩn hoá: không đổi (thêm FK và trigger, không thêm cột).
 * Khoá: `SHARE ROW EXCLUSIVE` trên `scheduled_tasks` và `organizations`, giữ tới hết lô 3A. Lần deploy đầu, mọi dòng
 * `scheduled_tasks` cũ đều mồ côi (bảng `organizations` mới rỗng) → lô fail to; runbook (README): tạo org tương ứng
 * hoặc xoá lịch mồ côi trước.
 */
export class Migration20260928232100_scheduled_tasks_org_link extends Migration {
  override name = 'Migration20260928232100_scheduled_tasks_org_link';

  override up(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT;`,
    );
    this
      .addSql(`CREATE FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  SELECT deleted_at INTO v_deleted_at FROM public.organizations WHERE id = NEW.org_id FOR SHARE;
  IF v_deleted_at IS NOT NULL THEN
    NEW.suspended_at := v_deleted_at;
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER scheduled_tasks_suspend_if_org_deleted BEFORE INSERT ON scheduled_tasks
    FOR EACH ROW EXECUTE FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted();`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `DROP TRIGGER scheduled_tasks_suspend_if_org_deleted ON scheduled_tasks;`,
    );
    this.addSql(
      `DROP FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted();`,
    );
    this.addSql(
      `ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_org_fk;`,
    );
  }
}
