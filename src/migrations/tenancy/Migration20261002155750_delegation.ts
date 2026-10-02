import { Migration } from '@mikro-orm/migrations';

const TABLES = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
/** Bảng mà `down` đọc để từ chối khi còn ủy quyền đang mở (mẫu NO FORCE … FORCE, spec §8.8). */
const GUARDED = ['org_api_keys', 'org_support_grants'] as const;

/**
 * Plan 3D (spec SP3 §6.10–6.11, §6.13 bảng 3D, §6.14): org API key và support grant.
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_api_keys | {id}, {org_id, public_id}, {token_hash} | created_by_member_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — E1. `token_hash → key_hint` là phụ thuộc từ khoá ứng viên (tầm thường); `key_hint` là snapshot bất biến |
 * | org_api_key_permissions | {api_key_id, permission_id} | api_key_id → org_id | 1NF hình thức (vi phạm 2NF) — E1 |
 * | org_support_grants | {id}, {org_id, public_id} | granted_by_member_id → org_id | 3NF; không BCNF — E1 |
 * | org_support_grant_permissions | {grant_id, permission_id} | grant_id → org_id | 1NF hình thức (vi phạm 2NF) — E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: FK kép `(org_id, x) → cha(org_id, id)` (bản sao
 * không khác org của cha), `SET NULL (cột)` chỉ xoá cột con, không grant `UPDATE (org_id)`, `WITH CHECK (org_id =
 * app_current_org())`, và FK `org_id → organizations` trực tiếp ở hai bảng gốc (neo, M5/B5). Phạm vi là bảng nối có FK tới
 * `permissions` (không JSON, spec §6.12 "Enum"). Không có cột `access_level` (P-2, CDX-14): grant v1 chỉ đọc.
 *
 * Index (mỗi cái một query): `org_api_keys_token_hash_uq` → `tenancy_find_org_api_key` ở mỗi request mang key (xuyên org);
 * `org_api_keys_creator_idx (org_id, created_by_member_id)` → liệt kê key của tôi, trần key mỗi member, FK CASCADE;
 * `org_api_keys_created_idx (org_id, created_at)` → liệt kê mọi key; `org_support_grants_active_uq (org_id, grantee_user_id)
 * WHERE revoked_at IS NULL` → một grant mở mỗi người nhận (T-20) và tra grant ở mỗi request của nhân viên;
 * `org_support_grants_grantee_idx (grantee_user_id)` → FK SET NULL khi xoá `tenancy_users` và
 * `tenancy_grantee_open_grant_orgs` (xuyên org); `org_support_grants_granter_idx (org_id, granted_by_member_id)` → FK SET
 * NULL; `org_support_grants_created_idx (org_id, created_at)` → liệt kê; PK bảng nối → đọc phạm vi;
 * `*_permission_idx (permission_id)` → FK RESTRICT và migration catalogue (xuyên org).
 *
 * Trigger: hai guard BEFORE INSERT quyền caller (eligibility; dòng quyền không thấy được → cho qua để FK quyết định);
 * closure hoãn dùng chung của 3B (`tenancy_permission_scope_closed_ck('api_key_id' | 'grant_id')`); trạng thái cuối
 * (`revoked_at` đặt một lần, `first_used_at` đặt một lần; bài học final review 3C M-2); hai constraint trigger hoãn
 * SECURITY DEFINER của `tenancy_definer` (grantee không là member ↔ member không có grant mở): kiểm READ COMMITTED, khoá
 * advisory theo org (`tenancy_org_lock_key`, cùng khoá với trigger owner cuối), rồi đọc lại dòng của chính nó; không phụ
 * thuộc `app.org_id` lúc COMMIT (T-19, DB2-M5, CDX-10).
 *
 * Hàm definer (S3-A31: tạo/xoá dưới SET LOCAL ROLE): `tenancy_find_org_api_key` (hash 32 byte; key chưa thu hồi còn hạn
 * theo `now()`, đọc không chờ khoá §3.15; trả `api_key_public_id` cho principal, SEC-M2), `tenancy_grantee_open_grant_orgs`
 * (mọi org có grant chưa thu hồi của grantee, kể cả đã hết hạn, ORDER BY org_id). NULL/sai độ dài → RAISE (DB-M3).
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `organizations`, `org_members` (FK + CREATE TRIGGER trên bảng sống), `tenancy_users`,
 * `permissions` tới hết lô 3D: đọc không bị chặn, ghi member/org chờ (ngắn).
 *
 * Down: từ chối khi còn key hoặc grant chưa thu hồi còn hạn (không xoá credential âm thầm), rồi xoá ngược thứ tự: trigger
 * trên `org_members`, bốn bảng, hàm definer và hai hàm trigger definer (dưới SET LOCAL ROLE), bốn hàm trigger quyền caller.
 * Không xoá hàm closure của 3B.
 */
export class Migration20261002155750_delegation extends Migration {
  override name = 'Migration20261002155750_delegation';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_api_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    created_by_member_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    token_hash BYTEA NOT NULL,
    key_hint TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_api_keys_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_api_keys_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_api_keys_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_api_keys_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_api_keys_creator_fk FOREIGN KEY (org_id, created_by_member_id) REFERENCES org_members (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_api_keys_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT org_api_keys_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_api_keys_key_hint_ck CHECK (key_hint ~ '^oak_[A-Za-z0-9_-]{6}$'),
    CONSTRAINT org_api_keys_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_api_keys_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_api_keys_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE INDEX org_api_keys_creator_idx ON org_api_keys (org_id, created_by_member_id);`,
    );
    this.addSql(
      `CREATE INDEX org_api_keys_created_idx ON org_api_keys (org_id, created_at);`,
    );

    this.addSql(`CREATE TABLE org_api_key_permissions (
    org_id UUID NOT NULL,
    api_key_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_api_key_permissions_pk PRIMARY KEY (org_id, api_key_id, permission_id),
    CONSTRAINT org_api_key_permissions_key_fk FOREIGN KEY (org_id, api_key_id) REFERENCES org_api_keys (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_api_key_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(
      `CREATE INDEX org_api_key_permissions_permission_idx ON org_api_key_permissions (permission_id);`,
    );

    this.addSql(`CREATE TABLE org_support_grants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    grantee_user_id BIGINT NULL,
    granted_by_member_id BIGINT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    first_used_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_support_grants_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_support_grants_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_support_grants_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_support_grants_grantee_fk FOREIGN KEY (grantee_user_id) REFERENCES tenancy_users (id) ON DELETE SET NULL,
    CONSTRAINT org_support_grants_granter_fk FOREIGN KEY (org_id, granted_by_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (granted_by_member_id),
    CONSTRAINT org_support_grants_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT org_support_grants_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_support_grants_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_support_grants_first_used_ck CHECK (first_used_at >= created_at),
    CONSTRAINT org_support_grants_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE UNIQUE INDEX org_support_grants_active_uq ON org_support_grants (org_id, grantee_user_id) WHERE revoked_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX org_support_grants_grantee_idx ON org_support_grants (grantee_user_id);`,
    );
    this.addSql(
      `CREATE INDEX org_support_grants_granter_idx ON org_support_grants (org_id, granted_by_member_id);`,
    );
    this.addSql(
      `CREATE INDEX org_support_grants_created_idx ON org_support_grants (org_id, created_at);`,
    );

    this.addSql(`CREATE TABLE org_support_grant_permissions (
    org_id UUID NOT NULL,
    grant_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_support_grant_permissions_pk PRIMARY KEY (org_id, grant_id, permission_id),
    CONSTRAINT org_support_grant_permissions_grant_fk FOREIGN KEY (org_id, grant_id) REFERENCES org_support_grants (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_support_grant_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(
      `CREATE INDEX org_support_grant_permissions_permission_idx ON org_support_grant_permissions (permission_id);`,
    );

    for (const t of TABLES) {
      this.addSql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      this.addSql(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      this.addSql(
        `CREATE POLICY ${t}_tenant ON ${t} TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`,
      );
      this.addSql(
        `CREATE POLICY ${t}_definer_read ON ${t} FOR SELECT TO tenancy_definer USING (true);`,
      );
    }
    // Spec §6.10–6.11: DELETE cho xoá cứng org (app_user trong OrgScope); UPDATE theo cột — chỉ thu hồi, lần dùng đầu và
    // version; phạm vi (bảng nối) bất biến sau khi tạo (không UPDATE; DELETE lẻ chỉ ở xoá cứng/migration catalogue).
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (revoked_at, version, updated_at) ON org_api_keys TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_api_key_permissions TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (revoked_at, first_used_at, version, updated_at) ON org_support_grants TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_support_grant_permissions TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (id, public_id, org_id, token_hash, revoked_at, expires_at) ON org_api_keys TO tenancy_definer;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, api_key_id, permission_id) ON org_api_key_permissions TO tenancy_definer;`,
    );
    this.addSql(
      `GRANT SELECT (id, org_id, grantee_user_id, revoked_at) ON org_support_grants TO tenancy_definer;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, grant_id, permission_id) ON org_support_grant_permissions TO tenancy_definer;`,
    );

    // Quyền caller: dòng quyền không thấy được (key không tồn tại) → cho qua để FK (23503) quyết định (spike S3B-2).
    this
      .addSql(`CREATE FUNCTION tenancy_org_api_key_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_eligible boolean;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT api_key_eligible, owner_only, deprecated_at INTO v_eligible, v_owner_only, v_deprecated
    FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND (NOT v_eligible OR v_owner_only OR v_deprecated IS NOT NULL) THEN
    RAISE EXCEPTION 'this permission cannot be delegated to an organization API key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_api_key_permissions_guard';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_api_key_permissions_guard BEFORE INSERT ON org_api_key_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_api_key_permissions_guard();`);
    // P-2: grant v1 chỉ đọc — eligible VÀ action = 'read'.
    this
      .addSql(`CREATE FUNCTION tenancy_org_support_grant_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_eligible boolean;
  v_action text;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT support_eligible, action, owner_only, deprecated_at INTO v_eligible, v_action, v_owner_only, v_deprecated
    FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND (NOT v_eligible OR v_action <> 'read' OR v_owner_only OR v_deprecated IS NOT NULL) THEN
    RAISE EXCEPTION 'this permission cannot be delegated to a support grant (read-only, support-eligible permissions only)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grant_permissions_guard';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_support_grant_permissions_guard BEFORE INSERT ON org_support_grant_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_support_grant_permissions_guard();`);
    this.addSql(`CREATE FUNCTION tenancy_org_api_keys_terminal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked organization API key stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_api_keys_revoked_once';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_api_keys_revoked_once BEFORE UPDATE OF revoked_at ON org_api_keys
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_api_keys_terminal();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_support_grants_terminal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked support grant stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_revoked_once';
  END IF;
  -- T-15: lần dùng đầu ghi đúng một lần; event \`.used\` gắn với lần ghi đó.
  IF OLD.first_used_at IS NOT NULL AND NEW.first_used_at IS DISTINCT FROM OLD.first_used_at THEN
    RAISE EXCEPTION 'the first use of a support grant is recorded once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_first_used_once';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_support_grants_terminal BEFORE UPDATE OF revoked_at, first_used_at ON org_support_grants
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_support_grants_terminal();`);
    // Closure dùng chung của 3B (app_owner có EXECUTE cho CREATE TRIGGER, migration 3B).
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_api_key_permissions_closed_ck AFTER INSERT OR DELETE ON org_api_key_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('api_key_id');`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_support_grant_permissions_closed_ck AFTER INSERT OR DELETE ON org_support_grant_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('grant_id');`);

    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_org_support_grants_grantee_not_member() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_grantee bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the support grantee check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_grantee_not_member';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(NEW.org_id));
  -- Đọc lại dòng của chính nó: đã thu hồi (MemberAdmission, cấp lại) hoặc người nhận đã SET NULL → không còn gì để kiểm.
  SELECT g.grantee_user_id INTO v_grantee FROM public.org_support_grants g
    WHERE g.org_id = NEW.org_id AND g.id = NEW.id AND g.revoked_at IS NULL;
  IF v_grantee IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.user_id = v_grantee) THEN
    RAISE EXCEPTION 'a support grantee must not be a member of the organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_grantee_not_member';
  END IF;
  RETURN NULL;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_org_members_no_active_support_grant() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the member/support grant check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_no_active_support_grant';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(NEW.org_id));
  IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.id = NEW.id) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.org_support_grants g
             WHERE g.org_id = NEW.org_id AND g.grantee_user_id = NEW.user_id AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a member must not hold an unrevoked support grant of the same organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_no_active_support_grant';
  END IF;
  RETURN NULL;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_find_org_api_key(p_token_hash bytea)
RETURNS TABLE (org_id uuid, api_key_id bigint, api_key_public_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_org_api_key: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_org_api_key: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT k.org_id, k.id, k.public_id FROM public.org_api_keys k
    WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now();
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_grantee_open_grant_orgs(p_user_id bigint)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_grantee_open_grant_orgs: p_user_id must not be NULL'; END IF;
  RETURN QUERY SELECT DISTINCT g.org_id FROM public.org_support_grants g
    WHERE g.grantee_user_id = p_user_id AND g.revoked_at IS NULL ORDER BY g.org_id;
END $$;`);
    for (const sig of [
      'tenancy_find_org_api_key(bytea)',
      'tenancy_grantee_open_grant_orgs(bigint)',
    ]) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    for (const sig of [
      'tenancy_org_support_grants_grantee_not_member()',
      'tenancy_org_members_no_active_support_grant()',
    ]) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      // CREATE TRIGGER (chạy bằng app_owner) đòi EXECUTE; lúc trigger bắn không kiểm EXECUTE nên app_user không cần.
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_owner;`);
    }
    this.addSql(`RESET ROLE;`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_support_grants_grantee_not_member AFTER INSERT ON org_support_grants
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_org_support_grants_grantee_not_member();`);
    this
      .addSql(`CREATE CONSTRAINT TRIGGER org_members_no_active_support_grant AFTER INSERT ON org_members
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_org_members_no_active_support_grant();`);
  }

  override down(): void | Promise<void> {
    for (const t of GUARDED)
      this.addSql(`ALTER TABLE public.${t} NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_api_keys WHERE revoked_at IS NULL AND expires_at > now())
     OR EXISTS (SELECT 1 FROM public.org_support_grants WHERE revoked_at IS NULL AND expires_at > now()) THEN
    RAISE EXCEPTION 'unrevoked organization API keys or support grants exist: revoke them (or wait for them to expire) before reverting plan 3D';
  END IF;
END $$;`);
    for (const t of GUARDED)
      this.addSql(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;`);
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
    this.addSql(
      `DROP TRIGGER org_members_no_active_support_grant ON org_members;`,
    );
    this.addSql(`DROP TABLE org_support_grant_permissions;`);
    this.addSql(`DROP TABLE org_support_grants;`);
    this.addSql(`DROP TABLE org_api_key_permissions;`);
    this.addSql(`DROP TABLE org_api_keys;`);
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(
      `DROP FUNCTION public.tenancy_grantee_open_grant_orgs(bigint);`,
    );
    this.addSql(`DROP FUNCTION public.tenancy_find_org_api_key(bytea);`);
    this.addSql(
      `DROP FUNCTION public.tenancy_org_members_no_active_support_grant();`,
    );
    this.addSql(
      `DROP FUNCTION public.tenancy_org_support_grants_grantee_not_member();`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP FUNCTION tenancy_org_support_grants_terminal();`);
    this.addSql(`DROP FUNCTION tenancy_org_api_keys_terminal();`);
    this.addSql(`DROP FUNCTION tenancy_org_support_grant_permissions_guard();`);
    this.addSql(`DROP FUNCTION tenancy_org_api_key_permissions_guard();`);
  }
}
