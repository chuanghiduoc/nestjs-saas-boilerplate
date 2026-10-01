import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4A (spec SP4 §7.1–7.3, §7.7 dòng `…_entitlements_core`).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | entitlement_features | {id}, {key} | — | BCNF (`reset_period` chỉ có với QUOTA: CHECK hai chiều, vẫn là thuộc tính của khoá) |
 * | plans | {id}, {key} | — | BCNF (giá trị gói ở code, S4-D2: không có dị thường cập nhật) |
 * | org_entitlements | {org_id} | — | BCNF (`plan_source_ref`, `plan_reason` thuộc lần gán hiện tại; `last_billing_seq` là sự thật độc lập) |
 * Không phi chuẩn hoá.
 *
 * Index (mỗi cái một query): `entitlement_features_key_uq` → catalogue check lúc boot, admin (4C), join snapshot (4C);
 * `plans_key_uq` → `assign` (`LEFT JOIN plans tgt ON tgt.key = ?`), participant/subscriber (`WHERE key = ?`), catalogue
 * check; PK `org_entitlements (org_id)` → câu snapshot, khoá `FOR NO KEY UPDATE` của `assign`, đích FK của hai bảng con
 * (4B, 4C); `org_entitlements_plan_idx (plan_id)` → kiểm FK RESTRICT khi migration xoá dòng `plans` (FK từ bảng global:
 * ngoại lệ có tên B6 của SP3, không bắt đầu bằng `org_id`).
 *
 * Trigger là INVOKER (`SET search_path = pg_catalog, public`), không SECURITY DEFINER: không hoãn và chỉ đọc NEW/OLD hoặc
 * bảng global `plans` (không RLS, app_user có SELECT). Bài học 3A (definer cho trigger hoãn đọc bảng tenant dưới FORCE)
 * không áp.
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `organizations` (REFERENCES): chặn GHI
 * `organizations` (tạo/xoá mềm org) trong lô; đọc không bị chặn. INSERT permissions/permission_requires lấy ROW EXCLUSIVE
 * (tương thích với đọc catalogue lúc boot).
 */
export class Migration20260929043935_entitlements_core extends Migration {
  override name = 'Migration20260929043935_entitlements_core';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE entitlement_features (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    reset_period TEXT NULL,
    deprecated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT entitlement_features_key_uq UNIQUE (key),
    CONSTRAINT entitlement_features_key_ck CHECK (key ~ '^[a-z][a-z0-9_]{0,31}\\.[a-z][a-z0-9_]{0,47}$'),
    CONSTRAINT entitlement_features_kind_ck CHECK (kind IN ('FLAG', 'LIMIT', 'QUOTA')),
    CONSTRAINT entitlement_features_reset_period_ck CHECK (reset_period IN ('NONE', 'MONTH')),
    CONSTRAINT entitlement_features_period_ck CHECK ((kind = 'QUOTA') = (reset_period IS NOT NULL)));`);
    this.addSql(`GRANT SELECT ON entitlement_features TO app_user;`);
    // Đổi loại hay kỳ làm dòng override/bộ đếm cũ mất nghĩa: cách đúng là key mới (spec §8.4). `deprecated_at` sửa được.
    this
      .addSql(`CREATE FUNCTION entitlements_feature_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reset_period IS DISTINCT FROM OLD.reset_period THEN
    RAISE EXCEPTION 'the key, kind and reset period of an entitlement feature are immutable; declare a new key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entitlement_features_immutable';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER entitlement_features_immutable BEFORE UPDATE ON entitlement_features
    FOR EACH ROW EXECUTE FUNCTION entitlements_feature_immutable();`);

    this.addSql(`CREATE TABLE plans (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key TEXT NOT NULL,
    retired_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plans_key_uq UNIQUE (key),
    CONSTRAINT plans_key_ck CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'));`);
    this.addSql(`GRANT SELECT ON plans TO app_user;`);
    this
      .addSql(`CREATE FUNCTION entitlements_plan_key_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'a plan key is immutable (prices of SP5 and code reference it)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'plans_key_immutable';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER plans_key_immutable BEFORE UPDATE OF key ON plans
    FOR EACH ROW EXECUTE FUNCTION entitlements_plan_key_immutable();`);

    this.addSql(`CREATE TABLE org_entitlements (
    org_id UUID PRIMARY KEY,
    plan_id BIGINT NOT NULL,
    plan_source TEXT NOT NULL,
    plan_source_ref TEXT NULL,
    plan_reason TEXT NULL,
    last_billing_seq BIGINT NULL,
    plan_assigned_at TIMESTAMPTZ NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_entitlements_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlements_plan_fk FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlements_source_ck CHECK (plan_source IN ('DEFAULT', 'BILLING', 'PLATFORM_ADMIN')),
    CONSTRAINT org_entitlements_source_ref_ck CHECK ((plan_source = 'BILLING') = (plan_source_ref IS NOT NULL)),
    CONSTRAINT org_entitlements_source_ref_length_ck CHECK (char_length(plan_source_ref) BETWEEN 1 AND 128),
    CONSTRAINT org_entitlements_reason_ck CHECK ((plan_source = 'PLATFORM_ADMIN') = (plan_reason IS NOT NULL)),
    CONSTRAINT org_entitlements_reason_format_ck CHECK (plan_reason = btrim(plan_reason) AND char_length(plan_reason) BETWEEN 1 AND 500),
    CONSTRAINT org_entitlements_billing_seq_ck CHECK (last_billing_seq >= 1),
    CONSTRAINT org_entitlements_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE INDEX org_entitlements_plan_idx ON org_entitlements (plan_id);`,
    );
    this.addSql(`ALTER TABLE org_entitlements ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_entitlements FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY org_entitlements_tenant ON org_entitlements TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_entitlements TO app_user;`,
    );
    // `FOR NO KEY UPDATE` của `assign` cần UPDATE trên ít nhất một cột; org_id, created_at không sửa được.
    this
      .addSql(`GRANT UPDATE (plan_id, plan_source, plan_source_ref, plan_reason, last_billing_seq, plan_assigned_at, version, updated_at)
    ON org_entitlements TO app_user;`);
    // Lớp chặn cuối của E-5 (app đã so dưới khoá). Vế `IS DISTINCT FROM` (K-1): câu APPLIED của nhân viên ghi
    // `last_billing_seq = COALESCE(NULL, last_billing_seq)` (giá trị không đổi) không bị chặn nhầm.
    this
      .addSql(`CREATE FUNCTION entitlements_billing_seq_monotonic() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.last_billing_seq IS DISTINCT FROM OLD.last_billing_seq AND OLD.last_billing_seq IS NOT NULL
     AND (NEW.last_billing_seq IS NULL OR NEW.last_billing_seq < OLD.last_billing_seq) THEN
    RAISE EXCEPTION 'last_billing_seq never goes back'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlements_billing_seq_monotonic';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_entitlements_billing_seq_monotonic BEFORE UPDATE OF last_billing_seq ON org_entitlements
    FOR EACH ROW EXECUTE FUNCTION entitlements_billing_seq_monotonic();`);
    // Không ai gán MỚI vào gói đã retire; org đang ở gói đó giữ được (gia hạn). Gói retire chỉ bằng migration (không race).
    this.addSql(`CREATE FUNCTION entitlements_plan_not_retired() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.plan_id <> OLD.plan_id)
     AND EXISTS (SELECT 1 FROM public.plans WHERE id = NEW.plan_id AND retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a retired plan cannot be newly assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlements_plan_not_retired';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_entitlements_plan_not_retired BEFORE INSERT OR UPDATE OF plan_id ON org_entitlements
    FOR EACH ROW EXECUTE FUNCTION entitlements_plan_not_retired();`);
    // Cùng mẫu SP2 (`security_notice`) và 3A (`tenancy_core`): hàm mới không để EXECUTE mặc định cho PUBLIC. Trigger vẫn
    // chạy khi app_user ghi: Postgres kiểm EXECUTE của hàm trigger lúc CREATE TRIGGER (chủ là app_owner), không lúc bắn.
    this
      .addSql(`REVOKE ALL ON FUNCTION public.entitlements_feature_immutable(), public.entitlements_plan_key_immutable(),
    public.entitlements_billing_seq_monotonic(), public.entitlements_plan_not_retired() FROM PUBLIC;`);

    // Tính năng boilerplate (spec §8.1): `tenancy.seats` là LIMIT; `fallback`/`minimum` chỉ ở code (S4-D2).
    this.addSql(
      `INSERT INTO entitlement_features (key, kind) VALUES ('tenancy.seats', 'LIMIT');`,
    );
    // Quyền đọc entitlement (S4-D17), vòng đời "Thêm" của SP3 §8.8: bảng global không FORCE nên không cần mẫu 7 bước.
    // `CatalogueCheck` của tenancy so dòng này với `EntitlementPermissions` trong code lúc boot.
    this
      .addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible)
    VALUES ('entitlements', 'read', false, true, true);`);
    this
      .addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'org.read' WHERE p.key = 'entitlements.read';`);
  }

  override down(): void | Promise<void> {
    // Fail to (23001, FK RESTRICT) nếu role tuỳ biến (3B) hoặc phạm vi key/grant (3D) còn giữ quyền: runbook thu hồi trước
    // (vòng đời "Xoá" của SP3 §8.8). Không xoá âm thầm quyền đang được dùng.
    this.addSql(
      `DELETE FROM permission_requires WHERE permission_id = (SELECT id FROM permissions WHERE key = 'entitlements.read');`,
    );
    this.addSql(`DELETE FROM permissions WHERE key = 'entitlements.read';`);
    // Ngược thứ tự: bảng con trước cha; DROP TABLE xoá trigger, policy, index, grant; hàm trigger xoá riêng.
    this.addSql(`DROP TABLE org_entitlements;`);
    this.addSql(`DROP TABLE plans;`);
    this.addSql(`DROP TABLE entitlement_features;`);
    this.addSql(`DROP FUNCTION entitlements_plan_not_retired();`);
    this.addSql(`DROP FUNCTION entitlements_billing_seq_monotonic();`);
    this.addSql(`DROP FUNCTION entitlements_plan_key_immutable();`);
    this.addSql(`DROP FUNCTION entitlements_feature_immutable();`);
  }
}
