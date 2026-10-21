import { Migration } from '@mikro-orm/migrations';

/**
 * Vùng TEMPLATE, plan SP7 7D (spec SP7 §7.1–§7.5).
 *
 * Bảng chuẩn hoá (spec §7.6; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | example_projects | {id}, {org_id, public_id}, {org_id, lower(name)} (khoá biểu thức, unique index) | — | BCNF |
 * `status` không suy ra từ `status_changed_at` và ngược lại (không có cột `archived_at` riêng: nó tạo `archived_at → status`).
 * `org_id` là neo tenant của chính dòng, không lặp từ bảng cha.
 *
 * Index (mỗi cái một query):
 * - `example_projects_org_public_uq`: tra theo `(org_id, public_id)` ở mọi route có `{projectId}`; list keyset
 *   `WHERE org_id = ? AND public_id < ? ORDER BY public_id DESC` (quét ngược, D7-1); phủ FK `org_id`;
 * - `example_projects_name_uq`: bất biến tên không trùng (không phân biệt hoa thường) trong org;
 * - `example_projects_purge_idx`: job xoá theo org (§7.4) và hàm quét `example_orgs_with_purgeable_projects` (§7.3).
 * Không index cho `?status=` (D7-20, spike S3: org 200.000 dòng, 0,71 ms trên `org_public_uq`).
 *
 * Owner: bảng thuộc app_owner; hàm quét thuộc `sweep_definer` (tạo/xoá DƯỚI `SET LOCAL ROLE`, R-X4). Hằng viết cứng
 * (migration không import code): 100/1000 = `EXAMPLE_PROJECT_NAME_MAX_LENGTH`/`EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH` (EX-I7),
 * p_limit 1000 = `DEFINER_LIMIT_MAX` (EX-I8).
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` ngắn trên `organizations` (FK); `ROW EXCLUSIVE` trên
 * `permissions`, `permission_requires`, `entitlement_features`. Down có canh (mẫu 3B/4B/6C): bỏ FORCE trước câu kiểm (dưới
 * FORCE app_owner thấy 0 dòng), từ chối khi còn project; FK RESTRICT (`23001`) chặn khi role tuỳ biến/key/grant còn giữ
 * `example_projects.*` hoặc org đã có bộ đếm/override của `example.*` — runbook: thu hồi/gỡ theo vòng đời trước.
 */
export class Migration20261021033513_example_projects extends Migration {
  override name = 'Migration20261021033513_example_projects';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer') THEN
    RAISE EXCEPTION 'role sweep_definer is missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE example_projects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT example_projects_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT example_projects_org_public_uq UNIQUE (org_id, public_id),
    CONSTRAINT example_projects_name_ck CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
    CONSTRAINT example_projects_description_ck CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
    CONSTRAINT example_projects_status_ck CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    CONSTRAINT example_projects_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE UNIQUE INDEX example_projects_name_uq ON example_projects (org_id, lower(name));`,
    );
    this.addSql(
      `CREATE INDEX example_projects_purge_idx ON example_projects (org_id, status_changed_at) WHERE status = 'ARCHIVED';`,
    );
    this.addSql(`ALTER TABLE example_projects ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE example_projects FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY example_projects_tenant ON example_projects TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY example_projects_definer_read ON example_projects FOR SELECT TO sweep_definer USING (true);`,
    );
    // `app_user` xoá được: xoá tay, job xoá và participant xoá cứng org đều chạy trong OrgScope.
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON example_projects TO app_user;`,
    );
    // `id`, `public_id`, `org_id`, `created_at` bất biến: không grant UPDATE (quy ước SP3 §6.1).
    this.addSql(
      `GRANT UPDATE (name, description, status, status_changed_at, version, updated_at) ON example_projects TO app_user;`,
    );
    // Đúng ba cột mà hàm quét đọc.
    this.addSql(
      `GRANT SELECT (org_id, status, status_changed_at) ON example_projects TO sweep_definer;`,
    );

    // Hàm quét xuyên org (spec §7.3, R-X14): chữ ký (p_after, p_limit) của `defineOrgSweep` + p_retention_sec theo tên.
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this
      .addSql(`CREATE FUNCTION public.example_orgs_with_purgeable_projects(p_after uuid, p_limit integer, p_retention_sec integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_retention_sec IS NULL
     OR p_limit < 1 OR p_limit > 1000 OR p_retention_sec < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'example_orgs_with_purgeable_projects: argument out of range';
  END IF;
  RETURN QUERY
    SELECT DISTINCT p.org_id FROM public.example_projects p
    WHERE p.status = 'ARCHIVED'
      AND p.status_changed_at <= now() - make_interval(secs => p_retention_sec)
      AND p.org_id > p_after
    ORDER BY p.org_id
    LIMIT p_limit;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer) TO app_user;`,
    );
    this.addSql(`RESET ROLE;`);

    // Catalogue `example` (spec §7.2): `CatalogueCheck` của tenancy so với `ExamplePermissions` lúc boot.
    this
      .addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('example_projects', 'read', false, true, true),
    ('example_projects', 'write', false, true, false),
    ('example_projects', 'delete', false, false, false);`);
    this
      .addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'example_projects.read'
WHERE p.key IN ('example_projects.write', 'example_projects.delete');`);
    // Tính năng SP4 (spec §7.2): `EntitlementCatalogueCheck` so với `ExampleFeatures` lúc boot.
    this
      .addSql(`INSERT INTO entitlement_features (key, kind, reset_period) VALUES
    ('example.projects', 'FLAG', NULL),
    ('example.project_count', 'QUOTA', 'NONE');`);
  }

  override down(): void | Promise<void> {
    // ALTER TABLE lấy ACCESS EXCLUSIVE giữ tới hết lô: tạo project đang mở thì down chờ nó, rồi thấy dòng của nó.
    this.addSql(
      `ALTER TABLE public.example_projects NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.example_projects) THEN
    RAISE EXCEPTION 'example_projects is not empty: delete projects or keep the migration';
  END IF;
END $$;`);
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(
      `DROP FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer);`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE example_projects;`);
    this.addSql(
      `DELETE FROM permission_requires WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'example_projects');`,
    );
    this.addSql(`DELETE FROM permissions WHERE resource = 'example_projects';`);
    this.addSql(
      `DELETE FROM entitlement_features WHERE key IN ('example.projects', 'example.project_count');`,
    );
    // Bước 7 của mẫu SP3 §8.8 (`migration-scan.spec.ts` đòi khối này sau `NO FORCE` cuối cùng, D7-12): không bảng tenant
    // nào còn lại mà mất FORCE.
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
