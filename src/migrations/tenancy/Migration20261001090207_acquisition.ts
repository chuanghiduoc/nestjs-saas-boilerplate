import { Migration } from '@mikro-orm/migrations';

const TABLES = [
  'org_invitations',
  'org_invite_links',
  'org_ownership_transfers',
] as const;

/**
 * Plan 3C (spec SP3 §6.7–6.9, §6.13 bảng 3C, §6.14): lời mời email, invite link, chuyển quyền sở hữu.
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_invitations | {id}, {org_id, public_id}, {token_hash} (khi khác NULL) | role_id → org_id, inviter_member_id → org_id, accepted_member_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — E1 |
 * | org_invite_links | {id}, {org_id, public_id}, {token_hash} | role_id → org_id, created_by_member_id → org_id | 3NF; không BCNF — E1 |
 * | org_ownership_transfers | {id}, {org_id, public_id} | from_member_id → org_id, to_member_id → org_id | 3NF; không BCNF — E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: mọi FK tới cha là FK kép `(org_id, x)` (bản sao
 * không khác org của cha), `SET NULL (x)` chỉ xoá cột con, không grant `UPDATE (org_id)`, `WITH CHECK (org_id =
 * app_current_org())`, và FK `org_id → organizations` trực tiếp (mọi FK kép có thể NULL, DB-I8). `email` là địa chỉ được
 * mời (có thể chưa có tài khoản), không phải bản sao `auth."user".email`. Trạng thái link suy ra, không lưu (spec §6.8).
 *
 * Index (mỗi cái một query): `*_token_hash_uq` → hàm definer tra token (xuyên org nên không bắt đầu bằng org_id);
 * `org_invitations_pending_email_uq` → chặn mời trùng song song (T-4) và đếm lời mời PENDING mỗi org (T-11, quét tiền tố
 * org_id); `*_created_idx (org_id, created_at)` → liệt kê; `*_role_idx`, `*_inviter_idx`, `*_accepted_member_idx`,
 * `*_created_by_idx`, `*_from_idx`, `*_to_idx` → hành động FK SET NULL khi xoá role/member, dọn theo role (xoá role) và
 * lọc theo bên tham gia; `org_invite_links_active_idx (org_id) WHERE revoked_at IS NULL` → đếm link đang mở (spec §6.8);
 * `org_ownership_transfers_pending_uq` → một yêu cầu PENDING mỗi org (T-16); `*_org_public_id_uq` → API và FK org_id.
 * Danh sách chuyển quyền mỗi org rất nhỏ (tối đa một PENDING), nên sắp theo `created_at` trên kết quả lọc `org_id` của
 * `*_org_public_id_uq`, không thêm index. Không có `UNIQUE (org_id, id)`: không bảng nào có FK kép trỏ tới ba bảng này.
 *
 * Trigger: bốn trigger BEFORE quyền caller (không hoãn: thấy đúng org của câu ghi; dòng role của org khác bị RLS giấu thì
 * cho qua để WITH CHECK trả 42501, spike S3C-2). `*_role_not_owner` cho qua `NEW.role_id IS NULL` (hành động FK SET NULL
 * là UPDATE có role_id trong target list, DB2-M1).
 *
 * Hàm definer (S3-A31: tạo dưới SET LOCAL ROLE): `tenancy_find_invitation`, `tenancy_find_invite_link` (tra hash 32 byte,
 * không cần OrgScope; tham số NULL hoặc sai độ dài → RAISE, DB-M3), `tenancy_count_user_memberships` (M7: mọi membership
 * của user, kể cả org xoá mềm, cho chế độ single-org). Chỉ đọc; `EXECUTE` chỉ cho app_user.
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `organizations`, `org_roles`, `org_members` (FK) tới hết lô 3C: đọc không bị chặn, ghi
 * member/role chờ (ngắn, spec §6.13 runbook).
 *
 * Down: từ chối khi còn lời mời PENDING chưa hết hạn, link đang mở, chuyển quyền PENDING chưa hết hạn (đọc theo mẫu
 * NO FORCE … FORCE + khẳng định, spec §8.8); rồi xoá ngược thứ tự: hàm definer (dưới SET LOCAL ROLE), bảng, hàm trigger.
 */
export class Migration20261001090207_acquisition extends Migration {
  override name = 'Migration20261001090207_acquisition';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_invitations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    email TEXT NOT NULL,
    role_id BIGINT NULL,
    inviter_member_id BIGINT NULL,
    status TEXT NOT NULL,
    token_hash BYTEA NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    accepted_member_id BIGINT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_invitations_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_invitations_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_invitations_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_invitations_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE SET NULL (role_id),
    CONSTRAINT org_invitations_inviter_fk FOREIGN KEY (org_id, inviter_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (inviter_member_id),
    CONSTRAINT org_invitations_accepted_member_fk FOREIGN KEY (org_id, accepted_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (accepted_member_id),
    CONSTRAINT org_invitations_email_ck CHECK (email = lower(btrim(email)) AND email IS NFC NORMALIZED AND char_length(email) <= 254),
    CONSTRAINT org_invitations_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'INVALIDATED')),
    CONSTRAINT org_invitations_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_invitations_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_invitations_resolved_ck CHECK (resolved_at >= created_at),
    CONSTRAINT org_invitations_pending_token_ck CHECK ((status = 'PENDING') = (token_hash IS NOT NULL)),
    CONSTRAINT org_invitations_pending_resolved_ck CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
    CONSTRAINT org_invitations_accepted_member_ck CHECK (status = 'ACCEPTED' OR accepted_member_id IS NULL),
    CONSTRAINT org_invitations_pending_role_ck CHECK (status <> 'PENDING' OR role_id IS NOT NULL),
    CONSTRAINT org_invitations_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE UNIQUE INDEX org_invitations_pending_email_uq ON org_invitations (org_id, email) WHERE status = 'PENDING';`,
    );
    this.addSql(
      `CREATE INDEX org_invitations_created_idx ON org_invitations (org_id, created_at);`,
    );
    this.addSql(
      `CREATE INDEX org_invitations_role_idx ON org_invitations (org_id, role_id);`,
    );
    this.addSql(
      `CREATE INDEX org_invitations_inviter_idx ON org_invitations (org_id, inviter_member_id);`,
    );
    this.addSql(
      `CREATE INDEX org_invitations_accepted_member_idx ON org_invitations (org_id, accepted_member_id);`,
    );

    this.addSql(`CREATE TABLE org_invite_links (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    role_id BIGINT NULL,
    created_by_member_id BIGINT NULL,
    token_hash BYTEA NOT NULL,
    max_uses INT NOT NULL,
    use_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_invite_links_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_invite_links_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_invite_links_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_invite_links_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE SET NULL (role_id),
    CONSTRAINT org_invite_links_created_by_fk FOREIGN KEY (org_id, created_by_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (created_by_member_id),
    CONSTRAINT org_invite_links_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_invite_links_max_uses_ck CHECK (max_uses >= 1),
    CONSTRAINT org_invite_links_use_count_ck CHECK (use_count >= 0 AND use_count <= max_uses),
    CONSTRAINT org_invite_links_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_invite_links_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_invite_links_active_role_ck CHECK (revoked_at IS NOT NULL OR role_id IS NOT NULL),
    CONSTRAINT org_invite_links_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE INDEX org_invite_links_created_idx ON org_invite_links (org_id, created_at);`,
    );
    this.addSql(
      `CREATE INDEX org_invite_links_active_idx ON org_invite_links (org_id) WHERE revoked_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX org_invite_links_role_idx ON org_invite_links (org_id, role_id);`,
    );
    this.addSql(
      `CREATE INDEX org_invite_links_created_by_idx ON org_invite_links (org_id, created_by_member_id);`,
    );

    this.addSql(`CREATE TABLE org_ownership_transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    from_member_id BIGINT NULL,
    to_member_id BIGINT NULL,
    step_down_to TEXT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_ownership_transfers_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_ownership_transfers_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_ownership_transfers_from_fk FOREIGN KEY (org_id, from_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (from_member_id),
    CONSTRAINT org_ownership_transfers_to_fk FOREIGN KEY (org_id, to_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (to_member_id),
    CONSTRAINT org_ownership_transfers_step_down_ck CHECK (step_down_to IN ('ADMIN', 'MEMBER')),
    CONSTRAINT org_ownership_transfers_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
    CONSTRAINT org_ownership_transfers_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_ownership_transfers_resolved_ck CHECK (resolved_at >= created_at),
    CONSTRAINT org_ownership_transfers_pending_resolved_ck CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
    CONSTRAINT org_ownership_transfers_pending_members_ck CHECK (status <> 'PENDING' OR (from_member_id IS NOT NULL AND to_member_id IS NOT NULL)),
    CONSTRAINT org_ownership_transfers_distinct_ck CHECK (from_member_id IS DISTINCT FROM to_member_id OR from_member_id IS NULL),
    CONSTRAINT org_ownership_transfers_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE UNIQUE INDEX org_ownership_transfers_pending_uq ON org_ownership_transfers (org_id) WHERE status = 'PENDING';`,
    );
    this.addSql(
      `CREATE INDEX org_ownership_transfers_from_idx ON org_ownership_transfers (org_id, from_member_id);`,
    );
    this.addSql(
      `CREATE INDEX org_ownership_transfers_to_idx ON org_ownership_transfers (org_id, to_member_id);`,
    );

    for (const t of TABLES) {
      this.addSql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      this.addSql(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      this.addSql(
        `CREATE POLICY ${t}_tenant ON ${t} TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`,
      );
    }
    this.addSql(
      `CREATE POLICY org_invitations_definer_read ON org_invitations FOR SELECT TO tenancy_definer USING (true);`,
    );
    this.addSql(
      `CREATE POLICY org_invite_links_definer_read ON org_invite_links FOR SELECT TO tenancy_definer USING (true);`,
    );
    // Spec §6.7–6.9: DELETE cho xoá cứng org (chạy bằng app_user trong OrgScope); UPDATE theo cột, không bao giờ org_id,
    // public_id, email, role_id, token_hash của link, max_uses, expires_at hay cột member (hành động FK chạy bằng owner).
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (status, token_hash, resolved_at, accepted_member_id, version, updated_at) ON org_invitations TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (use_count, revoked_at, version, updated_at) ON org_invite_links TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (status, resolved_at, version, updated_at) ON org_ownership_transfers TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (id, org_id, token_hash, status) ON org_invitations TO tenancy_definer;`,
    );
    this.addSql(
      `GRANT SELECT (id, org_id, token_hash, revoked_at) ON org_invite_links TO tenancy_definer;`,
    );

    this
      .addSql(`CREATE FUNCTION tenancy_org_invitations_token_clear_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- DB-M12: token chỉ được xoá (lời mời rời PENDING), không bao giờ đổi sang giá trị khác.
  IF NEW.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'an invitation token can only be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invitations_token_clear_only';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_invitations_token_clear_only BEFORE UPDATE OF token_hash ON org_invitations
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invitations_token_clear_only();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_invitations_role_not_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key = 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be granted by an invitation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invitations_role_not_owner';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_invitations_role_not_owner BEFORE INSERT OR UPDATE OF role_id ON org_invitations
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invitations_role_not_owner();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_invite_links_role_not_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key = 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be granted by an invite link'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invite_links_role_not_owner';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_invite_links_role_not_owner BEFORE INSERT OR UPDATE OF role_id ON org_invite_links
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invite_links_role_not_owner();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_invite_links_use_count_monotonic() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.use_count < OLD.use_count THEN
    RAISE EXCEPTION 'an invite link use count only grows'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invite_links_use_count_monotonic';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_invite_links_use_count_monotonic BEFORE UPDATE OF use_count ON org_invite_links
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invite_links_use_count_monotonic();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_invite_links_revoked_once() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Thu hồi là trạng thái cuối: \`revoked_at\` đặt một lần, không bao giờ xoá hay dời (final review 3C M-2).
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked invite link stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invite_links_revoked_once';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_invite_links_revoked_once BEFORE UPDATE OF revoked_at ON org_invite_links
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invite_links_revoked_once();`);
    this
      .addSql(`CREATE FUNCTION tenancy_org_ownership_transfers_status_terminal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Spec §9.3 (PR13): chỉ PENDING đổi được trạng thái; trạng thái cuối không đổi nữa và không quay về PENDING (final review 3C M-2).
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a finished ownership transfer keeps its status'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_ownership_transfers_status_terminal';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_ownership_transfers_status_terminal BEFORE UPDATE OF status ON org_ownership_transfers
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_ownership_transfers_status_terminal();`);

    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_find_invitation(p_token_hash bytea)
RETURNS TABLE (org_id uuid, invitation_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_invitation: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_invitation: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT i.org_id, i.id FROM public.org_invitations i WHERE i.token_hash = p_token_hash AND i.status = 'PENDING';
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_find_invite_link(p_token_hash bytea)
RETURNS TABLE (org_id uuid, invite_link_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_invite_link: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_invite_link: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT l.org_id, l.id FROM public.org_invite_links l WHERE l.token_hash = p_token_hash AND l.revoked_at IS NULL;
END $$;`);
    this
      .addSql(`CREATE FUNCTION public.tenancy_count_user_memberships(p_user_id bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_count_user_memberships: p_user_id must not be NULL'; END IF;
  RETURN (SELECT count(*) FROM public.org_members m WHERE m.user_id = p_user_id);
END $$;`);
    for (const sig of [
      'tenancy_find_invitation(bytea)',
      'tenancy_find_invite_link(bytea)',
      'tenancy_count_user_memberships(bigint)',
    ]) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    this.addSql(`RESET ROLE;`);
  }

  override down(): void | Promise<void> {
    // Không mất việc đang chờ âm thầm: người cầm token/yêu cầu sẽ nhận 404 mà không ai biết vì sao.
    for (const t of TABLES)
      this.addSql(`ALTER TABLE public.${t} NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_invitations WHERE status = 'PENDING' AND expires_at > now())
     OR EXISTS (SELECT 1 FROM public.org_invite_links WHERE revoked_at IS NULL AND expires_at > now() AND use_count < max_uses)
     OR EXISTS (SELECT 1 FROM public.org_ownership_transfers WHERE status = 'PENDING' AND expires_at > now()) THEN
    RAISE EXCEPTION 'open invitations, invite links or ownership transfers exist: revoke them or wait for them to expire before reverting plan 3C';
  END IF;
END $$;`);
    for (const t of TABLES)
      this.addSql(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;`);
    // Khẳng định bước 7 (spec §8.8) viết tại chỗ: luật quét đọc literal sau `NO FORCE` cuối cùng.
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
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_count_user_memberships(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_find_invite_link(bytea);`);
    this.addSql(`DROP FUNCTION public.tenancy_find_invitation(bytea);`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE org_ownership_transfers;`);
    this.addSql(`DROP TABLE org_invite_links;`);
    this.addSql(`DROP TABLE org_invitations;`);
    this.addSql(
      `DROP FUNCTION tenancy_org_ownership_transfers_status_terminal();`,
    );
    this.addSql(`DROP FUNCTION tenancy_org_invite_links_revoked_once();`);
    this.addSql(
      `DROP FUNCTION tenancy_org_invite_links_use_count_monotonic();`,
    );
    this.addSql(`DROP FUNCTION tenancy_org_invite_links_role_not_owner();`);
    this.addSql(`DROP FUNCTION tenancy_org_invitations_role_not_owner();`);
    this.addSql(`DROP FUNCTION tenancy_org_invitations_token_clear_only();`);
  }
}
