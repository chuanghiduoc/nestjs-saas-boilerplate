import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3A (spec SP3 §6.2–6.6, §6.13 bảng 3A). Task 15 thêm 6 hàm definer vào cuối `up` và đầu `down` của CHÍNH file này.
 *
 * Bảng chuẩn hoá (spec §6.12; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | tenancy_users | {id}, {public_id}, {auth_user_id}*, {external_subject}* | — | BCNF (đúng một subject: CHECK num_nonnulls) |
 * | permissions | {id}, {key}, {resource, action} | {resource, action} → key (cột sinh, đơn ánh) | BCNF |
 * | permission_requires | {permission_id, required_permission_id} | — | BCNF (toàn khoá) |
 * | organizations | {id} | — | BCNF (`purge_after` là lời hứa lúc xoá, không dẫn xuất từ `deleted_at`) |
 * | org_roles | {id}, {org_id, public_id}, {org_id, system_key}*, {org_id, lower(name)} (role tuỳ biến) | — | BCNF |
 * | org_members | {id}, {org_id, public_id}, {org_id, user_id}, {role_id, user_id} | role_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — ngoại lệ E1 |
 * (*) khoá trên các dòng khác NULL (DB2-M8).
 * E1 — `org_id` lặp ở bảng con cho RLS không join; giữ nhất quán ở DB: FK kép `(org_id, role_id) → org_roles(org_id, id)`,
 * không grant UPDATE trên `org_id`, policy `WITH CHECK (org_id = app_current_org())`.
 *
 * Index (mỗi cái một query): PK `organizations` (mọi tra trong OrgScope, câu đường nóng §7.3); `organizations_deleted_idx`
 * → `tenancy_orgs_due_for_purge` (keyset theo id trong tập org xoá mềm); `organizations_created_by_idx` →
 * `tenancy_count_orgs_created_by`, `tenancy_user_related_org_ids`, FK SET NULL từ `tenancy_users` (không bắt đầu bằng
 * org_id: hàm definer quét nhiều org / FK từ bảng global); `org_roles_org_id_uq` (đích FK kép, câu đường nóng),
 * `org_roles_org_public_id_uq` (API), `org_roles_org_system_key_uq` (tra role OWNER khi đếm owner, tạo org),
 * `org_roles_name_uq` (tên role tuỳ biến, 3B); `org_members_org_user_uq` (tra membership mỗi request tenant),
 * `org_members_org_id_uq` (đích FK kép), `org_members_org_public_id_uq` (API), `org_members_org_role_idx` (đếm owner
 * trong trigger, FK RESTRICT khi xoá role, `?roleId=`), `org_members_user_idx` (hàm definer theo user, FK RESTRICT từ
 * `tenancy_users`); `permission_requires_required_idx` (FK RESTRICT, closure 3B); UNIQUE của `tenancy_users` (tra
 * principal → id mỗi request, tra theo id của API).
 *
 * Khoá (giữ tới hết lô 3A, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `auth."user"` (REFERENCES): chạy
 * trong cửa sổ ít ghi (runbook, spec §6.13).
 */
export class Migration20260928213131_tenancy_core extends Migration {
  override name = 'Migration20260928213131_tenancy_core';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_definer') THEN
    RAISE EXCEPTION 'role tenancy_definer is missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE tenancy_users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    auth_user_id UUID NULL,
    external_subject TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenancy_users_public_id_uq UNIQUE (public_id),
    CONSTRAINT tenancy_users_auth_user_uq UNIQUE (auth_user_id),
    CONSTRAINT tenancy_users_external_subject_uq UNIQUE (external_subject),
    CONSTRAINT tenancy_users_auth_user_fk FOREIGN KEY (auth_user_id) REFERENCES auth."user" (id) ON DELETE RESTRICT,
    CONSTRAINT tenancy_users_external_subject_ck CHECK (char_length(external_subject) BETWEEN 1 AND 255),
    CONSTRAINT tenancy_users_one_subject_ck CHECK (num_nonnulls(auth_user_id, external_subject) = 1));`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON tenancy_users TO app_user;`);
    // Chỉ để khoá dòng (`FOR NO KEY UPDATE` đòi UPDATE trên ít nhất một cột, SEC-I2); không code nào sửa dòng này.
    this.addSql(`GRANT UPDATE (updated_at) ON tenancy_users TO app_user;`);

    this.addSql(`CREATE TABLE permissions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    key TEXT GENERATED ALWAYS AS (resource || '.' || action) STORED,
    owner_only BOOLEAN NOT NULL,
    api_key_eligible BOOLEAN NOT NULL,
    support_eligible BOOLEAN NOT NULL,
    deprecated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permissions_key_uq UNIQUE (key),
    CONSTRAINT permissions_resource_ck CHECK (resource ~ '^[a-z][a-z_]{0,31}$' AND resource <> 'all'),
    CONSTRAINT permissions_action_ck CHECK (action ~ '^[a-z][a-z_]{0,31}(\\.[a-z][a-z_]{0,31})?$' AND action <> 'manage'),
    CONSTRAINT permissions_owner_only_ck CHECK (NOT owner_only OR (NOT api_key_eligible AND NOT support_eligible)));`);
    this.addSql(`CREATE TABLE permission_requires (
    permission_id BIGINT NOT NULL,
    required_permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permission_requires_pk PRIMARY KEY (permission_id, required_permission_id),
    CONSTRAINT permission_requires_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE,
    CONSTRAINT permission_requires_required_fk FOREIGN KEY (required_permission_id) REFERENCES permissions (id) ON DELETE RESTRICT,
    CONSTRAINT permission_requires_not_self_ck CHECK (permission_id <> required_permission_id));`);
    this.addSql(
      `CREATE INDEX permission_requires_required_idx ON permission_requires (required_permission_id);`,
    );
    this.addSql(
      `GRANT SELECT ON permissions, permission_requires TO app_user;`,
    );

    this.addSql(`CREATE TABLE organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    created_by_user_id BIGINT NULL,
    version INT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    purge_after TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT organizations_id_v7_ck CHECK (uuid_extract_version(id) = 7),
    CONSTRAINT organizations_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT organizations_version_ck CHECK (version >= 1),
    CONSTRAINT organizations_deleted_pair_ck CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
    CONSTRAINT organizations_purge_after_ck CHECK (purge_after > deleted_at),
    CONSTRAINT organizations_created_by_fk FOREIGN KEY (created_by_user_id) REFERENCES tenancy_users (id) ON DELETE SET NULL);`);
    this.addSql(
      `CREATE INDEX organizations_deleted_idx ON organizations (id) WHERE deleted_at IS NOT NULL;`,
    );
    this.addSql(
      `CREATE INDEX organizations_created_by_idx ON organizations (created_by_user_id);`,
    );
    this.addSql(`ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY organizations_tenant ON organizations TO app_user
    USING (id = app_current_org()) WITH CHECK (id = app_current_org());`);
    this.addSql(
      `CREATE POLICY organizations_definer_read ON organizations FOR SELECT TO tenancy_definer USING (true);`,
    );
    this.addSql(`GRANT SELECT, INSERT, DELETE ON organizations TO app_user;`);
    this.addSql(
      `GRANT UPDATE (name, version, deleted_at, purge_after, created_by_user_id, updated_at) ON organizations TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (id, name, created_by_user_id, deleted_at, purge_after) ON organizations TO tenancy_definer;`,
    );

    this.addSql(`CREATE TABLE org_roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    system_key TEXT NULL,
    name TEXT NULL,
    description TEXT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_roles_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_roles_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_roles_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_roles_org_system_key_uq UNIQUE (org_id, system_key),
    CONSTRAINT org_roles_system_key_ck CHECK (system_key IN ('OWNER', 'ADMIN', 'MEMBER')),
    CONSTRAINT org_roles_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT org_roles_description_ck CHECK (char_length(description) <= 500),
    CONSTRAINT org_roles_version_ck CHECK (version >= 1),
    CONSTRAINT org_roles_kind_ck CHECK ((system_key IS NULL) = (name IS NOT NULL)),
    CONSTRAINT org_roles_system_no_description_ck CHECK (system_key IS NULL OR description IS NULL));`);
    this.addSql(
      `CREATE UNIQUE INDEX org_roles_name_uq ON org_roles (org_id, lower(name)) WHERE system_key IS NULL;`,
    );
    this.addSql(`ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_roles FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_roles_tenant ON org_roles TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY org_roles_definer_read ON org_roles FOR SELECT TO tenancy_definer USING (true);`,
    );
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_roles TO app_user;`);
    this.addSql(
      `GRANT UPDATE (name, description, version, updated_at) ON org_roles TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (id, org_id, public_id, system_key, name) ON org_roles TO tenancy_definer;`,
    );

    this.addSql(`CREATE TABLE org_members (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_members_org_user_uq UNIQUE (org_id, user_id),
    CONSTRAINT org_members_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_members_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_members_user_fk FOREIGN KEY (user_id) REFERENCES tenancy_users (id) ON DELETE RESTRICT,
    CONSTRAINT org_members_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT org_members_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE INDEX org_members_org_role_idx ON org_members (org_id, role_id);`,
    );
    this.addSql(`CREATE INDEX org_members_user_idx ON org_members (user_id);`);
    this.addSql(`ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_members FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_members_tenant ON org_members TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY org_members_definer_read ON org_members FOR SELECT TO tenancy_definer USING (true);`,
    );
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_members TO app_user;`);
    this.addSql(
      `GRANT UPDATE (role_id, version, updated_at) ON org_members TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (id, public_id, org_id, user_id, role_id, created_at) ON org_members TO tenancy_definer;`,
    );

    // T-23: lúc COMMIT, org mới (nếu còn) có đủ 3 role hệ thống và ≥ 1 member OWNER. Tạo org thiếu owner là không thể.
    this
      .addSql(`CREATE FUNCTION tenancy_organizations_bootstrap_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.id) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.org_roles WHERE org_id = NEW.id AND system_key IS NOT NULL) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE m.org_id = NEW.id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an organization must be created with its three system roles and an owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_bootstrap_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER organizations_bootstrap_ck AFTER INSERT ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenancy_organizations_bootstrap_ck();`);

    // DB-M6: khôi phục (deleted_at NOT NULL → NULL) đòi còn owner lúc COMMIT; chặn cả runbook SQL.
    this
      .addSql(`CREATE FUNCTION tenancy_organizations_restore_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.id AND deleted_at IS NULL) THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = NEW.id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an organization without an owner cannot be restored'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_restore_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER organizations_restore_owner_ck AFTER UPDATE OF deleted_at ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
    EXECUTE FUNCTION tenancy_organizations_restore_owner_ck();`);

    // S3-A5: role hệ thống là dòng bất biến; chỉ xoá được khi org đã xoá mềm (đang xoá cứng).
    this
      .addSql(`CREATE FUNCTION tenancy_org_roles_system_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.system_key IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM public.organizations WHERE id = OLD.org_id AND deleted_at IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'system roles cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'org_roles_system_immutable';
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_roles_system_immutable BEFORE UPDATE OR DELETE ON org_roles
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_roles_system_immutable();`);

    // T-1, T-28 (DB-I1): tự khoá dòng org TRƯỚC khi đếm; dưới READ COMMITTED câu đếm sau khoá thấy phần đã commit của bên
    // kia. Org đã xoá mềm hoặc đã mất (purge) được miễn. Không SECURITY DEFINER: tenancy_definer không khoá được dòng.
    this
      .addSql(`CREATE FUNCTION tenancy_org_members_last_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the last-owner check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  SELECT deleted_at INTO v_deleted_at FROM public.organizations WHERE id = OLD.org_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = OLD.org_id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an active organization must keep at least one owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_members_last_owner_ck AFTER UPDATE OF role_id OR DELETE ON org_members
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenancy_org_members_last_owner_ck();`);

    // Catalogue v1 (spec §8.2): migration không import code; `CatalogueCheck` (Task 19) so với catalogue trong code lúc boot.
    this
      .addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('org', 'read', false, true, true),
    ('org', 'update', false, false, false),
    ('org', 'delete', true, false, false),
    ('org', 'restore', true, false, false),
    ('ownership', 'transfer', true, false, false),
    ('members', 'read', false, true, true),
    ('members', 'role.assign', false, false, false),
    ('members', 'remove', false, false, false),
    ('roles', 'read', false, true, true),
    ('roles', 'write', false, false, false),
    ('invitations', 'read', false, false, true),
    ('invitations', 'write', false, false, false),
    ('api_keys', 'read', false, false, false),
    ('api_keys', 'write_own', false, false, false),
    ('api_keys', 'write_all', false, false, false),
    ('support_access', 'read', false, false, false),
    ('support_access', 'grant', true, false, false),
    ('billing', 'read', false, true, false),
    ('billing', 'write', true, false, false);`);
    this
      .addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM (VALUES
    ('org.update', 'org.read'),
    ('org.delete', 'org.read'),
    ('org.restore', 'org.read'),
    ('ownership.transfer', 'members.read'),
    ('members.role.assign', 'members.read'),
    ('members.role.assign', 'roles.read'),
    ('members.remove', 'members.read'),
    ('roles.write', 'roles.read'),
    ('invitations.read', 'roles.read'),
    ('invitations.write', 'invitations.read'),
    ('invitations.write', 'roles.read'),
    ('api_keys.read', 'members.read'),
    ('api_keys.write_all', 'api_keys.read'),
    ('api_keys.write_all', 'members.read'),
    ('support_access.grant', 'support_access.read'),
    ('support_access.grant', 'members.read'),
    ('billing.read', 'org.read'),
    ('billing.write', 'billing.read')
  ) AS e (k, req)
JOIN permissions p ON p.key = e.k
JOIN permissions r ON r.key = e.req;`);
  }

  override down(): void | Promise<void> {
    // Ngược thứ tự (spec §6.13, DB2-N1): con trước cha; DROP TABLE xoá trigger, policy, index, grant; hàm trigger phải
    // xoá riêng (không đi theo bảng).
    this.addSql(`DROP TABLE org_members;`);
    this.addSql(`DROP TABLE org_roles;`);
    this.addSql(`DROP TABLE organizations;`);
    this.addSql(`DROP TABLE permission_requires;`);
    this.addSql(`DROP TABLE permissions;`);
    this.addSql(`DROP TABLE tenancy_users;`);
    this.addSql(`DROP FUNCTION tenancy_org_members_last_owner_ck();`);
    this.addSql(`DROP FUNCTION tenancy_org_roles_system_immutable();`);
    this.addSql(`DROP FUNCTION tenancy_organizations_restore_owner_ck();`);
    this.addSql(`DROP FUNCTION tenancy_organizations_bootstrap_ck();`);
  }
}
