import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4B (spec SP4 §7.5, §7.7 dòng `…_usage_counters`).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | usage_counters | {id}, {org_id, feature_id, period_start} (NULLS NOT DISTINCT) | — | BCNF (không cột dẫn xuất: trần không lưu ở đây) |
 * Không phi chuẩn hoá. `kind`/`reset_period` không lặp vào bảng: trigger đọc từ `entitlement_features`.
 *
 * Index (mỗi cái một query): `usage_counters_period_uq` → arbiter `ON CONFLICT` của consume, khoá của release, câu đọc
 * usage kỳ hiện tại (quét theo `org_id`); `usage_counters_feature_idx (feature_id)` → kiểm FK RESTRICT khi migration xoá
 * tính năng (FK từ bảng global, ngoại lệ có tên B6 của SP3: không bắt đầu bằng `org_id`). PK `id` chỉ là `aggregate.id`
 * của `entitlements.quota.reached` (cần vì khoá tự nhiên có cột NULL).
 *
 * Trigger INVOKER (`SET search_path = pg_catalog, public`): chỉ đọc NEW và bảng global `entitlement_features` (không RLS,
 * app_user có SELECT), không hoãn. Không tạo hàm SECURITY DEFINER nào.
 *
 * Không `CHECK (used <= limit)`: trần đổi theo gói và `used > limit` sau hạ gói là trạng thái hợp lệ (S4-D13).
 *
 * Down: từ chối khi còn bộ đếm (usage không dẫn xuất lại được; lệch có chủ đích so với §7.7, SP3 §6.13 "down khi có dữ liệu chặn").
 *
 * Khoá (giữ tới hết lô): bảng mới; `SHARE ROW EXCLUSIVE` trên `org_entitlements` và `entitlement_features` (REFERENCES):
 * chặn ghi hai bảng đó trong lô (đổi gói, tạo org); đọc không bị chặn. INSERT dòng `files.storage_bytes` lấy ROW EXCLUSIVE.
 */
export class Migration20261005164759_usage_counters extends Migration {
  override name = 'Migration20261005164759_usage_counters';

  override up(): void | Promise<void> {
    // `usage_counters_used_ck` giữ `used` ≤ 2^53 − 1 (đọc ra JS bằng `Number` vẫn chính xác). Trần MAX luôn ≤ giá trị đó
    // (`ENTITLEMENT_VALUE_MAX`), nên chỉ consume UNLIMITED cộng dồn quá 2^53 − 1 mới chạm CHECK: câu bị từ chối (23514 →
    // `422 validation_failed` chung), không ghi gì, fail closed. Giữ như vậy có chủ đích (phán quyết review DB 4B, M4):
    // không thêm mã lỗi riêng cho một bộ đếm không giới hạn đã tiêu thụ 9·10^15 đơn vị.
    this.addSql(`CREATE TABLE usage_counters (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    feature_id BIGINT NOT NULL,
    period_start TIMESTAMPTZ NULL,
    used BIGINT NOT NULL DEFAULT 0,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT usage_counters_org_fk FOREIGN KEY (org_id) REFERENCES org_entitlements (org_id) ON DELETE RESTRICT,
    CONSTRAINT usage_counters_feature_fk FOREIGN KEY (feature_id) REFERENCES entitlement_features (id) ON DELETE RESTRICT,
    CONSTRAINT usage_counters_period_uq UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start),
    CONSTRAINT usage_counters_used_ck CHECK (used BETWEEN 0 AND 9007199254740991),
    CONSTRAINT usage_counters_version_ck CHECK (version >= 0));`);
    this.addSql(
      `CREATE INDEX usage_counters_feature_idx ON usage_counters (feature_id);`,
    );
    this.addSql(`ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY usage_counters_tenant ON usage_counters TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON usage_counters TO app_user;`);
    // `ON CONFLICT … DO UPDATE` cần UPDATE trên đúng các cột nó ghi; khoá tự nhiên và created_at không sửa được.
    this.addSql(
      `GRANT UPDATE (used, version, updated_at) ON usage_counters TO app_user;`,
    );
    // Spec §7.5: Postgres chạy BEFORE INSERT cho MỌI dòng đề xuất, kể cả khi câu kết thúc ở DO UPDATE (spike S4-T2 (c)),
    // nên consume trên tính năng sai loại/deprecated luôn bị chặn. Tính năng không tồn tại: để FK báo 23503.
    this
      .addSql(`CREATE FUNCTION entitlements_usage_counter_period_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE f record;
BEGIN
  SELECT kind, reset_period, deprecated_at INTO f FROM public.entitlement_features WHERE id = NEW.feature_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF f.kind <> 'QUOTA' OR f.deprecated_at IS NOT NULL OR (f.reset_period = 'NONE') <> (NEW.period_start IS NULL) THEN
    RAISE EXCEPTION 'a usage counter needs an active QUOTA feature and a period matching its reset period'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'usage_counters_period_ck';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER usage_counters_period_ck BEFORE INSERT ON usage_counters
    FOR EACH ROW EXECUTE FUNCTION entitlements_usage_counter_period_ck();`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.entitlements_usage_counter_period_ck() FROM PUBLIC;`,
    );
    // Tính năng boilerplate (spec §8.1, R-X8): trần dung lượng file. Chèn vô điều kiện (kể cả khi dự án tắt files) vì
    // catalogue check so tập tính năng code ↔ DB; `fallback`/`minimum` chỉ ở code (S4-D2). Adapter là của 6A (R-X29).
    this.addSql(
      `INSERT INTO entitlement_features (key, kind) VALUES ('files.storage_bytes', 'LIMIT');`,
    );
  }

  override down(): void | Promise<void> {
    // Dưới FORCE, app_owner không có policy nên thấy 0 dòng: bỏ FORCE để câu kiểm thấy thật. ALTER TABLE lấy ACCESS
    // EXCLUSIVE giữ tới hết lô, nên không consume nào chen vào giữa câu kiểm và DROP (consume đang mở thì down chờ nó).
    // RAISE → cả lô rollback, FORCE còn nguyên.
    this.addSql(
      `ALTER TABLE public.usage_counters NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.usage_counters) THEN
    RAISE EXCEPTION 'usage counters hold consumed quota; reverting usage_counters would reset the usage of every organization';
  END IF;
END $$;`);
    // Fail to (23001) nếu 4C đã có override trên `files.storage_bytes`: runbook xoá override trước (spec §7.7).
    this.addSql(
      `DELETE FROM entitlement_features WHERE key = 'files.storage_bytes';`,
    );
    this.addSql(`DROP TABLE usage_counters;`);
    this.addSql(`DROP FUNCTION entitlements_usage_counter_period_ck();`);
    // Bước 7 của mẫu SP3 §8.8 (`migration-scan.spec.ts` đòi khối này sau `NO FORCE` cuối cùng): không bảng tenant nào còn
    // lại mà mất FORCE.
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
  }
}
