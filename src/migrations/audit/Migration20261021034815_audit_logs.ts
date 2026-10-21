import { Migration } from '@mikro-orm/migrations';

/**
 * Plan SP6 6B (spec SP6 §6.4, §6.7, §6.9, §6.10 dòng 6B).
 *
 * Bảng chuẩn hoá (spec §6.9; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | audit_logs | {recorded_at, id}; {id} và {event_id} về ngữ nghĩa | actor_id → actor_user_id (snapshot E-A1) | 2NF hình thức; E-A1 |
 * | platform_audit_logs | {recorded_at, id}; {id} và {event_id} về ngữ nghĩa | actor_id → actor_user_id (snapshot E-A1) | 2NF hình thức; E-A1 |
 * {event_id} chỉ là khoá về ngữ nghĩa: `Inbox.once('audit.recorder', event_id)` trong cùng transaction với INSERT ép "một dòng
 * mỗi event" (R6-16, S6-A25), không có UNIQUE (một UNIQUE trên bảng partitioned phải chứa khoá partition). E-A1:
 * `actor_user_id` là `tenancy_users.public_id` chụp lúc ghi từ `actor_id`; nhất quán vì bảng chỉ-thêm (không dòng nào bị sửa
 * sau khi ghi), và lịch sử phải giữ đúng định danh lúc thao tác. `data` là tài liệu mờ (payload của event, đã qua schema zod),
 * không ai truy vấn theo trường bên trong.
 *
 * Index (mỗi cái một query của spec §8.2; keyset `(recorded_at DESC, id DESC)`):
 * - `audit_logs_org_recorded_idx`: danh sách mặc định của org;
 * - `audit_logs_org_action_idx`, `audit_logs_org_actor_idx`, `audit_logs_org_target_idx`: một bộ lọc chính mỗi lần;
 * - `audit_logs_org_correlation_idx`: lọc theo correlation (L2); lệch có chủ đích: mang thêm `recorded_at DESC, id DESC` để
 *   keyset không phải sort mọi dòng khớp;
 * - `platform_audit_logs_{action,actor,target,correlation}_idx`: cùng bộ lọc cho route admin (6D). Không có index mặc định
 *   riêng: PK `(recorded_at, id)` quét ngược phục vụ danh sách mặc định. Không index `event_id` (inbox ép, không ai tra).
 *
 * Owner: hai bảng partitioned, bốn hàm trigger và hàm bảo trì thuộc `partition_owner` (tạo/xoá DƯỚI `SET LOCAL ROLE`, spec
 * §3.2). Không FK nào (R-X27, R-X33, S6-A22): lịch sử sống lâu hơn org. Chỉ-thêm: `app_user` chỉ `SELECT, INSERT` trên bảng
 * cha; trigger dòng chặn UPDATE/DELETE (cả owner), trigger statement chặn TRUNCATE bảng cha; dữ liệu chỉ mất bằng
 * `DETACH` + `DROP` partition hết hạn.
 * Hằng viết cứng (migration không import code; `constants-vs-migration.spec.ts` so với code): lockKey 6001 =
 * `AUDIT_PARTITIONS_LOCK_KEY`, sàn retention 6 = `AUDIT_RETENTION_MIN_MONTHS`, trần 120 = `AUDIT_RETENTION_MAX_MONTHS`, premake
 * 12 = `AUDIT_PREMAKE_MAX_MONTHS`, 255 = `AUDIT_TEXT_MAX_LENGTH`, tập `actor_type` = `ACTOR_TYPES` của core.
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `ROW EXCLUSIVE` ngắn trên `permissions`. Down có canh (mẫu 3B/4B/6C):
 * dòng audit là dấu vết pháp lý, nên từ chối khi còn dòng nào; bỏ FORCE trước câu kiểm vì dưới FORCE owner không có policy nên
 * thấy 0 dòng; `ALTER TABLE` giữ ACCESS EXCLUSIVE tới hết lô nên không ghi nào chen giữa câu kiểm và DROP; `DELETE FROM
 * permissions` bị FK RESTRICT (`23001`) chặn nếu role tuỳ biến còn giữ `audit.read` (lỗi to; runbook gỡ quyền trước). Dòng
 * `processed_events` của consumer `audit.recorder` giữ nguyên, vô hại.
 */

const auditColumns = (table: string, withOrg: boolean): string => `
    id BIGINT GENERATED ALWAYS AS IDENTITY,${withOrg ? '\n    org_id UUID NOT NULL,' : ''}
    event_id UUID NOT NULL,
    action TEXT NOT NULL,
    action_version INT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_user_id UUID NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ${table}_pk PRIMARY KEY (recorded_at, id),
    CONSTRAINT ${table}_action_ck CHECK (action ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'),
    CONSTRAINT ${table}_action_version_ck CHECK (action_version > 0),
    CONSTRAINT ${table}_actor_type_ck CHECK (actor_type IN ('user', 'system', 'service')),
    CONSTRAINT ${table}_actor_id_ck CHECK (char_length(actor_id) BETWEEN 1 AND 255),
    CONSTRAINT ${table}_actor_user_ck CHECK (actor_user_id IS NULL OR actor_type = 'user'),
    CONSTRAINT ${table}_target_type_ck CHECK (char_length(target_type) BETWEEN 1 AND 255),
    CONSTRAINT ${table}_target_id_ck CHECK (char_length(target_id) BETWEEN 1 AND 255),
    CONSTRAINT ${table}_correlation_id_ck CHECK (char_length(correlation_id) BETWEEN 1 AND 255),
    CONSTRAINT ${table}_causation_id_ck CHECK (causation_id IS NULL OR char_length(causation_id) BETWEEN 1 AND 255),
    CONSTRAINT ${table}_data_ck CHECK (jsonb_typeof(data) = 'object')`;

export class Migration20261021034815_audit_logs extends Migration {
  override name = 'Migration20261021034815_audit_logs';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_owner') THEN
    RAISE EXCEPTION 'role partition_owner is missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);
    // R-X27, R-X33, S6-A22: không FK nào từ hai bảng partitioned; partition_owner không nhận REFERENCES nào.
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(
      `CREATE TABLE audit_logs (${auditColumns('audit_logs', true)}) PARTITION BY RANGE (recorded_at);`,
    );
    this.addSql(
      `CREATE TABLE platform_audit_logs (${auditColumns('platform_audit_logs', false)}) PARTITION BY RANGE (recorded_at);`,
    );
    this.addSql(
      `CREATE INDEX audit_logs_org_recorded_idx ON audit_logs (org_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX audit_logs_org_action_idx ON audit_logs (org_id, action, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX audit_logs_org_actor_idx ON audit_logs (org_id, actor_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX audit_logs_org_target_idx ON audit_logs (org_id, target_type, target_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX audit_logs_org_correlation_idx ON audit_logs (org_id, correlation_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX platform_audit_logs_action_idx ON platform_audit_logs (action, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX platform_audit_logs_actor_idx ON platform_audit_logs (actor_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX platform_audit_logs_target_idx ON platform_audit_logs (target_type, target_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(
      `CREATE INDEX platform_audit_logs_correlation_idx ON platform_audit_logs (correlation_id, recorded_at DESC, id DESC);`,
    );
    this.addSql(`ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY audit_logs_tenant ON audit_logs TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    // Chỉ thêm: không UPDATE/DELETE/TRUNCATE cho ai ngoài owner; trigger chặn cả owner khi đi qua bảng cha.
    this.addSql(`GRANT SELECT, INSERT ON audit_logs TO app_user;`);
    this.addSql(`GRANT SELECT, INSERT ON platform_audit_logs TO app_user;`);
    // Trigger dòng (nhân bản sang mọi partition, spike P1) chặn UPDATE/DELETE; trigger statement chặn TRUNCATE bảng cha.
    // TRUNCATE một partition đơn lẻ (trigger statement không nhân bản) chỉ owner làm được = quyền DETACH + DROP vốn có.
    this.addSql(`CREATE FUNCTION public.audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.audit_logs_append_only() FROM PUBLIC;`,
    );
    this
      .addSql(`CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.audit_logs_append_only();`);
    this.addSql(`CREATE FUNCTION public.audit_logs_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: drop expired partitions instead of TRUNCATE' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.audit_logs_no_truncate() FROM PUBLIC;`,
    );
    this
      .addSql(`CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_no_truncate();`);
    this
      .addSql(`CREATE FUNCTION public.platform_audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.platform_audit_logs_append_only() FROM PUBLIC;`,
    );
    this
      .addSql(`CREATE TRIGGER platform_audit_logs_append_only BEFORE UPDATE OR DELETE ON public.platform_audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.platform_audit_logs_append_only();`);
    this
      .addSql(`CREATE FUNCTION public.platform_audit_logs_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only: drop expired partitions instead of TRUNCATE' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.platform_audit_logs_no_truncate() FROM PUBLIC;`,
    );
    this
      .addSql(`CREATE TRIGGER platform_audit_logs_no_truncate BEFORE TRUNCATE ON public.platform_audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_logs_no_truncate();`);
    // Hàm bảo trì (spec §6.7; mẫu của fixture 6.0 và Migration20261010032022_webhooks.ts): lock_timeout là thuộc tính hàm.
    this
      .addSql(`CREATE FUNCTION public.audit_partitions_maintain(p_retention_months integer, p_premake_months integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s' AS $$
#variable_conflict use_column
DECLARE
  v_base timestamp;
  v_lo timestamp;
  v_name text;
  v_cutoff timestamp;
  v_table text;
  r record;
BEGIN
  IF p_retention_months IS NULL OR p_premake_months IS NULL THEN
    RAISE EXCEPTION 'audit_partitions_maintain: arguments must not be NULL';
  END IF;
  -- Sàn retention cứng ở đây (AUDIT_RETENTION_MIN_MONTHS): SQLi bằng app_user không hạ được dưới sàn (T11).
  IF p_retention_months < 6 OR p_retention_months > 120 THEN
    RAISE EXCEPTION 'audit_partitions_maintain: p_retention_months must be between 6 and 120';
  END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN
    RAISE EXCEPTION 'audit_partitions_maintain: p_premake_months must be between 1 and 12';
  END IF;
  -- R6-17: một lượt mỗi lúc (AUDIT_PARTITIONS_LOCK_KEY); lượt thứ hai là no-op.
  IF NOT pg_try_advisory_xact_lock(6001) THEN RETURN; END IF;
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOREACH v_table IN ARRAY ARRAY['audit_logs', 'platform_audit_logs'] LOOP
    FOR i IN 0..p_premake_months LOOP
      v_lo := v_base + make_interval(months => i);
      v_name := v_table || '_p' || to_char(v_lo, 'YYYYMM');
      IF to_regclass('public.' || v_name) IS NULL THEN
        EXECUTE format('CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name, v_table);
        EXECUTE format('ALTER TABLE public.%I ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
          v_table, v_name, v_lo AT TIME ZONE 'UTC', (v_lo + interval '1 month') AT TIME ZONE 'UTC');
        action := 'created'; partition_name := v_name; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  -- Retention thực tế N..N+1 tháng: chỉ drop khi TOÀN BỘ tháng của partition cũ hơn N tháng (spec §6.7).
  v_cutoff := v_base - make_interval(months => p_retention_months);
  FOREACH v_table IN ARRAY ARRAY['audit_logs', 'platform_audit_logs'] LOOP
    FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = ('public.' || v_table)::regclass ORDER BY c.relname LOOP
      IF r.relname !~ ('^' || v_table || '_p[0-9]{6}$') THEN
        RAISE EXCEPTION 'audit_partitions_maintain: unexpected partition %', r.relname;
      END IF;
      v_lo := to_date(substring(r.relname FROM '[0-9]{6}$'), 'YYYYMM')::timestamp;
      IF v_lo + interval '1 month' <= v_cutoff THEN
        EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', v_table, r.relname);
        EXECUTE format('DROP TABLE public.%I', r.relname);
        action := 'dropped'; partition_name := r.relname; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.audit_partitions_maintain(integer, integer) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.audit_partitions_maintain(integer, integer) TO app_user;`,
    );
    // Partition đầu: tháng hiện tại + 3 tháng tới (= mặc định AUDIT_PARTITION_PREMAKE_MONTHS), retention mặc định 13.
    this.addSql(
      `SELECT count(*) FROM public.audit_partitions_maintain(13, 3);`,
    );
    this.addSql(`RESET ROLE;`);
    // Catalogue `audit` (spec §9.1): `CatalogueCheck` của tenancy so với `AuditPermissions` lúc boot (Task 4).
    this
      .addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('audit', 'read', false, true, false);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DELETE FROM permissions WHERE key = 'audit.read';`);
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_logs) OR EXISTS (SELECT 1 FROM public.platform_audit_logs) THEN
    RAISE EXCEPTION 'audit rows exist; reverting the audit migration would destroy the audit trail (see the runbook)';
  END IF;
END $$;`);
    this.addSql(`DROP TABLE public.audit_logs;`);
    this.addSql(`DROP TABLE public.platform_audit_logs;`);
    this.addSql(
      `DROP FUNCTION public.audit_partitions_maintain(integer, integer);`,
    );
    this.addSql(`DROP FUNCTION public.audit_logs_append_only();`);
    this.addSql(`DROP FUNCTION public.audit_logs_no_truncate();`);
    this.addSql(`DROP FUNCTION public.platform_audit_logs_append_only();`);
    this.addSql(`DROP FUNCTION public.platform_audit_logs_no_truncate();`);
    this.addSql(`RESET ROLE;`);
    // Bước 7 của mẫu SP3 §8.8 (`migration-scan.spec.ts` đòi khối này sau `NO FORCE` cuối cùng).
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
