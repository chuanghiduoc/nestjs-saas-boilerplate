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
 * Trigger bất biến: ba trigger hoãn (`organizations_bootstrap_ck`, `organizations_restore_owner_ck`,
 * `org_members_last_owner_ck`) là `SECURITY DEFINER` thuộc `tenancy_definer` (đọc qua `_definer_read`, không phụ thuộc
 * `app.org_id` lúc COMMIT); hai trigger owner tuần tự hoá bằng `pg_advisory_xact_lock(tenancy_org_lock_key(org))`.
 * `org_roles_system_immutable` giữ quyền caller (fail closed).
 * Hàm definer (6, spec §6.14): biên p_limit 1000 = DEFINER_LIMIT_MAX của `constants.ts` (migration không import code; test definer-functions.spec.ts khoá hai giá trị bằng nhau).
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

    // Hàm nội bộ của tenancy_definer (spec §6.4, §6.6): ba trigger hoãn là SECURITY DEFINER. Dưới quyền caller, RLS
    // giấu mọi org khác `app.org_id` lúc COMMIT, nên caller đổi `app.org_id` giữa transaction là câu kiểm đạt âm thầm; dưới
    // tenancy_definer câu kiểm đọc qua policy `_definer_read` và thấy trạng thái thật. `search_path = ''`: tên bảng/hàm
    // đều viết `public.`, còn `pg_catalog` luôn được tìm ngầm. Tạo sau khi chuyển role sang tenancy_definer để hàm thuộc role
    // đó (S3-A31); `REVOKE … FROM PUBLIC`; `app_owner` có `EXECUTE` trên ba hàm trigger chỉ vì `CREATE TRIGGER` đòi quyền
    // đó (lúc trigger bắn không kiểm `EXECUTE`, nên `app_user` không cần grant).
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);

    // T-1, T-28: khoá advisory theo org của hai trigger owner, định nghĩa ở ĐÚNG một chỗ (hai trigger phải cùng khoá để
    // tuần tự hoá nhau). tenancy_definer không khoá được dòng `organizations` (chỉ có SELECT theo cột → 42501), nên khoá
    // dòng org của bản đầu được thay bằng khoá này. Seed 3171 chỉ đổi giá trị băm, KHÔNG tạo không gian khoá riêng: mọi
    // advisory lock một bigint dùng chung không gian, nên va chạm với người dùng khoá bigint khác chỉ là khó xảy ra (~2^-64
    // mỗi cặp khoá) và chỉ gây chờ thêm, không làm câu kiểm sai; xấu nhất là COMMIT chờ tới statement_timeout (trùng với
    // một advisory lock bigint mức session giữ lâu: 57014, app thấy commit_outcome_unknown) hoặc deadlock 40P01 bị Postgres
    // huỷ một bên. Repo chưa có người dùng advisory lock nào khác; người dùng sau nên chọn seed khác, hoặc dạng hai khoá
    // int4 (không gian tách hẳn với dạng bigint).
    this
      .addSql(`CREATE FUNCTION public.tenancy_org_lock_key(p_org_id uuid) RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
BEGIN
  -- Không STRICT (DB-M3): NULL cho khoá NULL và pg_advisory_xact_lock(NULL) bỏ qua khoá âm thầm.
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'tenancy_org_lock_key: org id must not be NULL';
  END IF;
  RETURN pg_catalog.hashtextextended(p_org_id::text, 3171);
END $$;`);

    // T-23: lúc COMMIT, org mới (nếu còn) có đủ 3 role hệ thống và ≥ 1 member OWNER. Tạo org thiếu owner là không thể.
    // Không cần khoá: org mới chưa commit thì không giao dịch nào khác thấy để đổi owner của nó.
    this
      .addSql(`CREATE FUNCTION public.tenancy_organizations_bootstrap_ck() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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

    // DB-M6: khôi phục (deleted_at NOT NULL → NULL) đòi còn owner lúc COMMIT; chặn cả runbook SQL. Lấy khoá advisory của
    // org TRƯỚC khi đọc để tuần tự hoá với `org_members_last_owner_ck` (khôi phục ∥ xoá owner cuối của org xoá mềm: bên
    // sau thấy phần đã commit của bên trước). Vì dựa vào snapshot mới sau khoá nên đòi READ COMMITTED như trigger kia
    // (spec §6.1): dưới REPEATABLE READ câu đếm dùng snapshot cũ và khôi phục được org vừa mất owner.
    this
      .addSql(`CREATE FUNCTION public.tenancy_organizations_restore_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the restore owner check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_restore_owner_ck';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(NEW.id));
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.id AND deleted_at IS NULL) THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = NEW.id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an organization without an owner cannot be restored'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_restore_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);

    // T-1, T-28 (DB-I1): lấy khoá advisory của org TRƯỚC khi đọc; dưới READ COMMITTED câu đọc sau khoá thấy phần đã commit
    // của bên kia (khoá được nhả sau khi commit đã hiện). Org đã xoá mềm hoặc đã mất (purge) được miễn.
    this
      .addSql(`CREATE FUNCTION public.tenancy_org_members_last_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the last-owner check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(OLD.org_id));
  SELECT deleted_at INTO v_deleted_at FROM public.organizations WHERE id = OLD.org_id;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = OLD.org_id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an active organization must keep at least one owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.tenancy_org_lock_key(uuid), public.tenancy_organizations_bootstrap_ck(), public.tenancy_organizations_restore_owner_ck(), public.tenancy_org_members_last_owner_ck() FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.tenancy_organizations_bootstrap_ck(), public.tenancy_organizations_restore_owner_ck(), public.tenancy_org_members_last_owner_ck() TO app_owner;`,
    );
    this.addSql(`RESET ROLE;`);

    this
      .addSql(`CREATE CONSTRAINT TRIGGER organizations_bootstrap_ck AFTER INSERT ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_organizations_bootstrap_ck();`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER organizations_restore_owner_ck AFTER UPDATE OF deleted_at ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
    EXECUTE FUNCTION public.tenancy_organizations_restore_owner_ck();`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_members_last_owner_ck AFTER UPDATE OF role_id OR DELETE ON org_members
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_org_members_last_owner_ck();`);

    // S3-A5: role hệ thống là dòng bất biến; chỉ xoá được khi org đã xoá mềm (đang xoá cứng). Giữ quyền caller: dòng role
    // thấy được thì org của nó cũng thấy được (cùng `app_current_org()`); nếu org bị giấu thì EXISTS sai → từ chối (fail
    // closed), không có đường đạt âm thầm như ba trigger hoãn.
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

    // Spec §6.14, S3-A2, S3-A31: hàm SECURITY DEFINER chỉ đọc, sở hữu bởi tenancy_definer (chỉ SELECT theo cột + policy
    // `FOR SELECT TO tenancy_definer USING (true)`, không ghi được). Tạo/xoá DƯỚI `SET LOCAL ROLE`: với INHERIT FALSE,
    // app_owner không phải owner của hàm (PG ≥ 16). Tham số NULL hoặc ngoài biên → RAISE (không STRICT: STRICT trả rỗng
    // âm thầm, và `tenancy_user_sole_owner_orgs(NULL)` rỗng sẽ cho phép xoá tài khoản).
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_list_user_orgs(p_user_id bigint, p_include_deleted boolean, p_limit integer, p_offset integer)
RETURNS TABLE (org_id uuid, org_name text, org_deleted_at timestamptz, org_purge_after timestamptz,
               member_public_id uuid, role_public_id uuid, role_system_key text, role_name text, joined_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL OR p_include_deleted IS NULL OR p_limit IS NULL OR p_offset IS NULL THEN
    RAISE EXCEPTION 'tenancy_list_user_orgs: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'tenancy_list_user_orgs: p_limit must be between 1 and 1000'; END IF;
  IF p_offset < 0 THEN RAISE EXCEPTION 'tenancy_list_user_orgs: p_offset must not be negative'; END IF;
  RETURN QUERY
    SELECT o.id, o.name, o.deleted_at, o.purge_after, m.public_id, r.public_id, r.system_key, r.name, m.created_at
    FROM public.org_members m
    JOIN public.organizations o ON o.id = m.org_id
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.user_id = p_user_id AND (o.deleted_at IS NULL OR (p_include_deleted AND r.system_key = 'OWNER'))
    ORDER BY m.created_at, m.id
    LIMIT p_limit OFFSET p_offset;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_count_user_orgs(p_user_id bigint, p_include_deleted boolean)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL OR p_include_deleted IS NULL THEN RAISE EXCEPTION 'tenancy_count_user_orgs: arguments must not be NULL'; END IF;
  RETURN (
    SELECT count(*) FROM public.org_members m
    JOIN public.organizations o ON o.id = m.org_id
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.user_id = p_user_id AND (o.deleted_at IS NULL OR (p_include_deleted AND r.system_key = 'OWNER')));
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_count_orgs_created_by(p_user_id bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_count_orgs_created_by: p_user_id must not be NULL'; END IF;
  RETURN (SELECT count(*) FROM public.organizations o WHERE o.created_by_user_id = p_user_id);
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_user_sole_owner_orgs(p_user_id bigint)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_user_sole_owner_orgs: p_user_id must not be NULL'; END IF;
  RETURN QUERY
    SELECT m.org_id FROM public.org_members m
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    JOIN public.organizations o ON o.id = m.org_id
    WHERE m.user_id = p_user_id AND r.system_key = 'OWNER' AND o.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.org_members m2
        JOIN public.org_roles r2 ON r2.org_id = m2.org_id AND r2.id = m2.role_id
        WHERE m2.org_id = m.org_id AND r2.system_key = 'OWNER' AND m2.user_id <> p_user_id)
    ORDER BY m.org_id;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_user_related_org_ids(p_user_id bigint)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_user_related_org_ids: p_user_id must not be NULL'; END IF;
  RETURN QUERY
    SELECT x.org_id FROM (
      SELECT m.org_id FROM public.org_members m WHERE m.user_id = p_user_id
      UNION
      SELECT o.id FROM public.organizations o WHERE o.created_by_user_id = p_user_id) AS x
    ORDER BY x.org_id;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_orgs_due_for_purge(p_after uuid, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL THEN RAISE EXCEPTION 'tenancy_orgs_due_for_purge: arguments must not be NULL'; END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'tenancy_orgs_due_for_purge: p_limit must be between 1 and 1000'; END IF;
  RETURN QUERY
    SELECT o.id FROM public.organizations o
    WHERE o.deleted_at IS NOT NULL AND o.purge_after <= now() AND o.id > p_after
    ORDER BY o.id LIMIT p_limit;
END $$;`);
    for (const sig of [
      'tenancy_list_user_orgs(bigint, boolean, integer, integer)',
      'tenancy_count_user_orgs(bigint, boolean)',
      'tenancy_count_orgs_created_by(bigint)',
      'tenancy_user_sole_owner_orgs(bigint)',
      'tenancy_user_related_org_ids(bigint)',
      'tenancy_orgs_due_for_purge(uuid, integer)',
    ]) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    this.addSql(`RESET ROLE;`);
  }

  override down(): void | Promise<void> {
    // Ngược thứ tự (spec §6.13, DB2-N1): con trước cha; DROP TABLE xoá trigger, policy, index, grant; hàm trigger phải
    // xoá riêng (không đi theo bảng).
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(
      `DROP FUNCTION public.tenancy_orgs_due_for_purge(uuid, integer);`,
    );
    this.addSql(`DROP FUNCTION public.tenancy_user_related_org_ids(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_user_sole_owner_orgs(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_count_orgs_created_by(bigint);`);
    this.addSql(
      `DROP FUNCTION public.tenancy_count_user_orgs(bigint, boolean);`,
    );
    this.addSql(
      `DROP FUNCTION public.tenancy_list_user_orgs(bigint, boolean, integer, integer);`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE org_members;`);
    this.addSql(`DROP TABLE org_roles;`);
    this.addSql(`DROP TABLE organizations;`);
    this.addSql(`DROP TABLE permission_requires;`);
    this.addSql(`DROP TABLE permissions;`);
    this.addSql(`DROP TABLE tenancy_users;`);
    this.addSql(`DROP FUNCTION tenancy_org_roles_system_immutable();`);
    // Hàm thuộc tenancy_definer: app_owner (INHERIT FALSE) không phải owner nên phải `SET LOCAL ROLE` (S3-A31).
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_org_members_last_owner_ck();`);
    this.addSql(
      `DROP FUNCTION public.tenancy_organizations_restore_owner_ck();`,
    );
    this.addSql(`DROP FUNCTION public.tenancy_organizations_bootstrap_ck();`);
    this.addSql(`DROP FUNCTION public.tenancy_org_lock_key(uuid);`);
    this.addSql(`RESET ROLE;`);
  }
}
