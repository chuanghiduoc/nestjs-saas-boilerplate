import { Migration } from '@mikro-orm/migrations';

/**
 * Spec SP3 §5.2, §6.13 bảng 3A (DB-I10, S3-A39): lịch của org xoá mềm bị treo bằng cột riêng, không đụng `enabled`.
 *
 * Bảng chuẩn hoá (spec §6.12, bảng bị sửa):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm | Dạng |
 * |---|---|---|---|
 * | scheduled_tasks | {id}, {org_id, key} | như SP1; `suspended_at` là trạng thái của nền tảng, độc lập với `enabled` (ý định của feature) | BCNF |
 *
 * Khoá: `ACCESS EXCLUSIVE` trên `scheduled_tasks` (chỉ đổi metadata, không quét), giữ tới hết lô 3A (`allOrNothing`).
 * Không index: mọi câu lọc `suspended_at` đi kèm `org_id = app_current_org()` (UNIQUE (org_id, key)) hoặc quét toàn bảng
 * của reconciler (đã quét toàn bảng từ SP1).
 *
 * Down: đọc bảng FORCE RLS bằng `app_owner` phải theo mẫu `NO FORCE … FORCE` + khẳng định (spec §8.8): dưới FORCE
 * `app_owner` thấy 0 dòng và guard không bao giờ chặn (DB2-N2).
 */
export class Migration20260928180939_scheduled_tasks_suspended_at extends Migration {
  override name = 'Migration20260928180939_scheduled_tasks_suspended_at';

  override up(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE scheduled_tasks ADD COLUMN suspended_at TIMESTAMPTZ NULL;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE public.scheduled_tasks NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.scheduled_tasks WHERE suspended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'scheduled tasks of soft-deleted organizations would run again; restore or purge those organizations before reverting';
  END IF;
END $$;`);
    this.addSql(`ALTER TABLE public.scheduled_tasks FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
    this.addSql(`ALTER TABLE scheduled_tasks DROP COLUMN suspended_at;`);
  }
}
