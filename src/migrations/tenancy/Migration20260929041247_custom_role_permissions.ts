import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3B (spec SP3 §6.5, §6.13 bảng 3B): quyền của role tuỳ biến. Role hệ thống không có dòng ở đây (S3-A5, tập tính
 * trong code).
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_role_permissions | {role_id, permission_id} | role_id → org_id | 1NF hình thức: org_id ngoài khoá tối thiểu, phụ thuộc một phần khoá (vi phạm 2NF) — ngoại lệ E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: FK kép `(org_id, role_id) → org_roles(org_id, id)`
 * (bản sao không thể khác org của role), không grant UPDATE nào (bất biến), policy `WITH CHECK (org_id = app_current_org())`.
 * PK `(org_id, role_id, permission_id)` là siêu khoá, giữ `org_id` đứng đầu cho RLS.
 *
 * Index (mỗi cái một query): PK → câu thứ hai của đường nóng (spec §7.3) và mọi lần đọc tập quyền của role
 * (`org_id = app_current_org() AND role_id = ANY(?)`); `org_role_permissions_permission_idx` → FK RESTRICT khi xoá quyền
 * khỏi `permissions` và migration dữ liệu catalogue (quét xuyên org nên không bắt đầu bằng org_id).
 *
 * Trigger: `org_role_permissions_guard` (BEFORE INSERT, quyền caller: trigger không hoãn thấy đúng org của câu ghi);
 * `org_role_permissions_closed_ck` (hoãn) gọi hàm dùng chung `tenancy_permission_scope_closed_ck(owner_column)` —
 * SECURITY DEFINER của tenancy_definer (dưới quyền caller + FORCE RLS, câu kiểm lúc COMMIT chỉ thấy org của `app.org_id`
 * lúc COMMIT và đạt âm thầm khi caller đổi org; bài học Task 13 của 3A), kiểm READ COMMITTED, lấy khoá advisory theo org
 * (`tenancy_org_lock_key`, cùng khoá với trigger owner cuối) rồi mới đọc: hai kết nối SQL không khoá cùng sửa một tập
 * (thêm quyền phụ thuộc ∥ bỏ quyền bị yêu cầu) không commit được cả hai (write skew, spike S3B-4). 3D gắn cùng hàm lên
 * `org_api_key_permissions` ('api_key_id') và `org_support_grant_permissions` ('grant_id'); `down` của 3D không xoá hàm.
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `org_roles` và `permissions` (FK) tới hết lô 3B: đọc không bị chặn, ghi role chờ (ngắn).
 */
export class Migration20260929041247_custom_role_permissions extends Migration {
  override name = 'Migration20260929041247_custom_role_permissions';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_role_permissions (
    org_id UUID NOT NULL,
    role_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_role_permissions_pk PRIMARY KEY (org_id, role_id, permission_id),
    CONSTRAINT org_role_permissions_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(
      `CREATE INDEX org_role_permissions_permission_idx ON org_role_permissions (permission_id);`,
    );
    this.addSql(`ALTER TABLE org_role_permissions ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_role_permissions FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY org_role_permissions_tenant ON org_role_permissions TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY org_role_permissions_definer_read ON org_role_permissions FOR SELECT TO tenancy_definer USING (true);`,
    );
    // Sửa role = xoá/thêm dòng; không UPDATE (spec §6.5). DELETE cũng cho xoá cứng org (chạy bằng app_user trong OrgScope).
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_role_permissions TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, role_id, permission_id) ON org_role_permissions TO tenancy_definer;`,
    );
    this.addSql(
      `GRANT SELECT (permission_id, required_permission_id) ON permission_requires TO tenancy_definer;`,
    );

    // Quyền caller: dòng role/quyền không thấy được (RLS giấu org khác; key không tồn tại) → trả NEW để WITH CHECK (42501)
    // hoặc FK (23503) quyết định, giữ đúng mã của tiêu chí 1 (spike S3B-2). Thấy được thì kiểm ba luật.
    this
      .addSql(`CREATE FUNCTION tenancy_org_role_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key IS NOT NULL THEN
    RAISE EXCEPTION 'system roles hold no stored permissions'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_custom_only';
  END IF;
  SELECT owner_only, deprecated_at INTO v_owner_only, v_deprecated FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND v_owner_only THEN
    RAISE EXCEPTION 'owner-only permissions cannot be delegated'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_not_delegable';
  END IF;
  IF FOUND AND v_deprecated IS NOT NULL THEN
    RAISE EXCEPTION 'deprecated permissions cannot be granted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_deprecated';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_role_permissions_guard BEFORE INSERT ON org_role_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_role_permissions_guard();`);

    // Hàm nội bộ của tenancy_definer (S3-A31: tạo dưới SET LOCAL ROLE). `app_owner` có EXECUTE chỉ vì CREATE TRIGGER đòi
    // (ở đây và ở migration 3D); lúc trigger bắn không kiểm EXECUTE nên app_user không cần grant.
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_permission_scope_closed_ck() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb;
  v_org uuid;
  v_owner bigint;
  v_missing bigint;
BEGIN
  IF TG_NARGS <> 1 THEN
    RAISE EXCEPTION 'tenancy_permission_scope_closed_ck expects the owner column as its only argument';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the permission closure check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
  v_org := (v_row ->> 'org_id')::uuid;
  v_owner := (v_row ->> TG_ARGV[0])::bigint;
  IF v_org IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'tenancy_permission_scope_closed_ck: row without org_id or %', TG_ARGV[0];
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(v_org));
  -- Tập đã bị xoá hết (role/key/grant bị xoá, CASCADE) → không còn dòng → đạt.
  EXECUTE format(
    'SELECT s.permission_id FROM %1$I.%2$I s JOIN public.permission_requires r ON r.permission_id = s.permission_id
     WHERE s.org_id = $1 AND s.%3$I = $2
       AND NOT EXISTS (SELECT 1 FROM %1$I.%2$I t WHERE t.org_id = $1 AND t.%3$I = $2 AND t.permission_id = r.required_permission_id)
     LIMIT 1', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0])
    INTO v_missing USING v_org, v_owner;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'a stored permission set must be closed under requires'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.tenancy_permission_scope_closed_ck() FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.tenancy_permission_scope_closed_ck() TO app_owner;`,
    );
    this.addSql(`RESET ROLE;`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_role_permissions_closed_ck AFTER INSERT OR DELETE ON org_role_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('role_id');`);
  }

  override down(): void | Promise<void> {
    // Không mất dữ liệu âm thầm: còn role tuỳ biến thì từ chối (member giữ nó sẽ mất mọi quyền; code 3A ném 500 cho role
    // tuỳ biến). `org_roles` là FORCE RLS: app_owner đọc theo mẫu NO FORCE … FORCE + khẳng định (spec §8.8).
    this.addSql(`ALTER TABLE public.org_roles NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_roles WHERE system_key IS NULL) THEN
    RAISE EXCEPTION 'custom roles exist: move their members to a system role and delete the custom roles before reverting plan 3B';
  END IF;
END $$;`);
    this.addSql(`ALTER TABLE public.org_roles FORCE ROW LEVEL SECURITY;`);
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
    this.addSql(`DROP TABLE org_role_permissions;`);
    this.addSql(
      `REVOKE SELECT (permission_id, required_permission_id) ON permission_requires FROM tenancy_definer;`,
    );
    this.addSql(`DROP FUNCTION tenancy_org_role_permissions_guard();`);
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_permission_scope_closed_ck();`);
    this.addSql(`RESET ROLE;`);
  }
}
