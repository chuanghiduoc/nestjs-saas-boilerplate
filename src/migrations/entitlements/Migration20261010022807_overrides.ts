import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4C (spec SP4 §7.4, §7.7 dòng `…_overrides`).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_entitlement_overrides | {org_id, feature_id} | — | BCNF (`kind` không lặp vào bảng: trigger đọc từ `entitlement_features`) |
 * Không phi chuẩn hoá. Không `version` riêng: override thuộc aggregate `org_entitlements` (mọi ghi khoá dòng gốc và tăng
 * `org_entitlements.version` cùng transaction).
 *
 * Index (mỗi cái một query): PK `(org_id, feature_id)` → LEFT JOIN của câu snapshot (quét theo `org_id`), upsert/xoá của
 * admin, danh sách override của view admin; `org_entitlement_overrides_feature_idx (feature_id)` → kiểm FK RESTRICT khi
 * migration xoá tính năng (FK từ bảng global, ngoại lệ có tên B6 của SP3: không bắt đầu bằng `org_id`).
 *
 * Trigger INVOKER (`SET search_path = pg_catalog, public`): chỉ đọc NEW và bảng global `entitlement_features` (không RLS,
 * app_user có SELECT), không hoãn. Không tạo hàm SECURITY DEFINER nào. `minimum` của tính năng chỉ ở code (S4-D2).
 *
 * `org_entitlement_overrides_expiry_ck` (lệch có chủ đích so với §7.4, plan 4C Task 2): mọi ghi đặt
 * `updated_at = clock_timestamp()`, nên "override không bao giờ được ghi khi đã hết hạn" là bất biến của dòng.
 *
 * Khoá (giữ tới hết lô): bảng mới; `SHARE ROW EXCLUSIVE` trên `org_entitlements` và `entitlement_features` (REFERENCES):
 * chặn ghi hai bảng đó trong lô (đổi gói, tạo org); đọc không bị chặn.
 * Down: từ chối khi còn override (quyết định của nhân viên không dẫn xuất lại được; lệch có chủ đích so với §7.7, SP3 §6.13 "down khi có dữ liệu chặn"); chặn luôn việc lùi …_usage_counters khi còn override trên files.storage_bytes (DB-4 (d)).
 */
export class Migration20261010022807_overrides extends Migration {
  override name = 'Migration20261010022807_overrides';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_entitlement_overrides (
    org_id UUID NOT NULL,
    feature_id BIGINT NOT NULL,
    flag_value BOOLEAN NULL,
    limit_value BIGINT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_entitlement_overrides_pkey PRIMARY KEY (org_id, feature_id),
    CONSTRAINT org_entitlement_overrides_org_fk FOREIGN KEY (org_id) REFERENCES org_entitlements (org_id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlement_overrides_feature_fk FOREIGN KEY (feature_id) REFERENCES entitlement_features (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlement_overrides_limit_ck CHECK (limit_value BETWEEN 0 AND 9007199254740991),
    CONSTRAINT org_entitlement_overrides_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT org_entitlement_overrides_one_value_ck CHECK (num_nonnulls(flag_value, limit_value) <= 1),
    CONSTRAINT org_entitlement_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at));`);
    this.addSql(
      `CREATE INDEX org_entitlement_overrides_feature_idx ON org_entitlement_overrides (feature_id);`,
    );
    this.addSql(
      `ALTER TABLE org_entitlement_overrides ENABLE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE org_entitlement_overrides FORCE ROW LEVEL SECURITY;`,
    );
    this
      .addSql(`CREATE POLICY org_entitlement_overrides_tenant ON org_entitlement_overrides TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_entitlement_overrides TO app_user;`,
    );
    // `ON CONFLICT … DO UPDATE` cần UPDATE trên đúng các cột nó ghi; khoá tự nhiên và created_at không sửa được.
    this.addSql(
      `GRANT UPDATE (flag_value, limit_value, reason, expires_at, updated_at) ON org_entitlement_overrides TO app_user;`,
    );
    // Spec §7.4: giá trị đúng `kind` của tính năng, tính năng chưa deprecated. Chạy ở BEFORE INSERT (dòng đề xuất) và
    // BEFORE UPDATE (dòng sau SET của nhánh DO UPDATE, spike S4C-1). Tính năng không tồn tại: để FK báo 23503.
    this
      .addSql(`CREATE FUNCTION entitlements_override_value_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE f record;
BEGIN
  SELECT kind, deprecated_at INTO f FROM public.entitlement_features WHERE id = NEW.feature_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF f.deprecated_at IS NOT NULL
     OR (f.kind = 'FLAG' AND (NEW.flag_value IS NULL OR NEW.limit_value IS NOT NULL))
     OR (f.kind <> 'FLAG' AND NEW.flag_value IS NOT NULL) THEN
    RAISE EXCEPTION 'an override needs an active feature and a value of its kind'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlement_overrides_value_ck';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_entitlement_overrides_value_ck BEFORE INSERT OR UPDATE ON org_entitlement_overrides
    FOR EACH ROW EXECUTE FUNCTION entitlements_override_value_ck();`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.entitlements_override_value_ck() FROM PUBLIC;`,
    );
  }

  override down(): void | Promise<void> {
    // Dưới FORCE, app_owner không có policy nên thấy 0 dòng: bỏ FORCE để câu kiểm thấy thật. ALTER TABLE lấy ACCESS
    // EXCLUSIVE giữ tới hết lô, nên không ghi override nào chen vào giữa câu kiểm và DROP (ghi đang mở thì down chờ nó).
    // RAISE → cả lô rollback, FORCE còn nguyên. Đây cũng là chỗ chặn ca DB-4 (d): lùi `…_usage_counters` khi còn override
    // trên `files.storage_bytes` dừng ở bước này (migrator lùi migration mới nhất trước).
    this.addSql(
      `ALTER TABLE public.org_entitlement_overrides NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_entitlement_overrides) THEN
    RAISE EXCEPTION 'org entitlement overrides hold staff decisions; reverting org_entitlement_overrides would drop every override';
  END IF;
END $$;`);
    this.addSql(`DROP TABLE org_entitlement_overrides;`);
    this.addSql(`DROP FUNCTION entitlements_override_value_ck();`);
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
