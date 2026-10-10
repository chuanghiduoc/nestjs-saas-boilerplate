import { Migration } from '@mikro-orm/migrations';

/**
 * Plan SP6 6C (spec SP6 §6.5, §6.7, §6.8, §6.10 dòng 6C).
 *
 * Bảng chuẩn hoá (spec §6.9; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | webhook_event_types | {type} | — | BCNF |
 * | webhook_endpoints | {id}, {org_id, public_id} | — | BCNF (`disabled_reason` gắn `status` bằng CHECK hai chiều) |
 * | webhook_endpoint_secrets | {id}, {org_id, public_id}, {org_id, endpoint_id} khi expires_at IS NULL | endpoint_id → org_id | 3NF; E1 |
 * | webhook_endpoint_event_types | {org_id, endpoint_id, event_type} | endpoint_id → org_id | 1NF hình thức; E1 |
 * | webhook_messages | {created_at, id}; {id} về ngữ nghĩa | — | BCNF (body thuộc message, không lặp ở delivery) |
 * | webhook_deliveries | {created_at, id}, {public_id, created_at}, {org_id, message_id, created_at, endpoint_id} | endpoint_id → org_id; message_id → created_at, org_id | 3NF; E1 |
 * E1 (SP3): `org_id` lặp ở bảng con cho RLS không join; nhất quán bằng FK kép `(org_id, x_id)`, không grant UPDATE trên
 * `org_id`, policy `WITH CHECK (org_id = app_current_org())`. `created_at` của delivery bằng của message: FK
 * `(org_id, message_id, created_at)` ép. Bảng partitioned không FK tới `organizations` (R-X27): `org_id` được giữ bằng RLS +
 * ghi trong OrgScope + participant purge.
 *
 * Index (mỗi cái một query):
 * - `webhook_endpoints_org_public_id_uq` (API), `webhook_endpoints_org_id_uq` (đích FK kép);
 * - `webhook_endpoints_live_idx` (đếm giới hạn mỗi org R6-26, fan-out, WebhookStatsReader);
 * - `webhook_endpoints_purge_idx` (hàm quét xuyên org, sweep xoá cứng);
 * - `webhook_endpoint_secrets_current_uq` (một secret hiện hành), `webhook_endpoint_secrets_endpoint_idx` (đọc secret còn hạn lúc claim);
 * - `webhook_endpoint_secrets_expiry_idx` (M5: hàm quét và sweep xoá secret đã hết hạn);
 * - `webhook_endpoint_event_types_org_type_idx` (fan-out theo event), `webhook_endpoint_event_types_type_idx` (FK RESTRICT từ catalog);
 * - `webhook_messages_org_created_idx` (participant purge);
 * - `webhook_deliveries_public_id_uq` (job/API tra theo id; không prune partition: ≤ retention + premake partition, S6-A26);
 * - `webhook_deliveries_message_endpoint_uq` (một delivery mỗi message × endpoint; tiền tố `(org_id, message_id, created_at)` phục vụ FK RESTRICT khi xoá message);
 * - `webhook_deliveries_endpoint_created_idx` (danh sách delivery của endpoint, keyset `(created_at, public_id)` giảm dần; `NOT EXISTS` của sweep xoá cứng endpoint);
 * - `webhook_deliveries_due_idx`, `webhook_deliveries_lease_idx` (hàm quét và sweep);
 * - `webhook_deliveries_endpoint_status_idx` (recover, `?status=`, đếm `SENDING` của endpoint lúc claim — bulkhead R-X35).
 *
 * Owner: bảng thường thuộc app_owner; hai bảng partitioned và hàm bảo trì thuộc `partition_owner`; hàm quét thuộc
 * `sweep_definer` (tạo/xoá DƯỚI `SET LOCAL ROLE`, spec §3.2). R-X33 (spike W3): không FK từ bảng partitioned tới bảng thường
 * nóng — `DETACH` + `DROP` partition mang FK `webhook_deliveries → webhook_endpoints` lấy `AccessExclusiveLock` trên
 * `webhook_endpoints` (chặn cả SELECT), `ATTACH` lấy `ShareRowExclusiveLock` (chặn ghi). Vì vậy `partition_owner` không nhận
 * REFERENCES nào trên bảng thường; bất biến "mọi delivery có endpoint" giữ bằng `FOR KEY SHARE OF e` khi fan-out chèn delivery
 * và `NOT EXISTS` dưới `FOR UPDATE` của dòng endpoint khi sweep xoá cứng (Task 10, Task 11), test ở Task 3.
 * Hằng viết cứng (migration không import code; `constants-vs-migration.spec.ts` so với code): lockKey 6002 =
 * `WEBHOOK_PARTITIONS_LOCK_KEY`, sàn retention 1 = `WEBHOOK_RETENTION_MIN_MONTHS`, 262144 = `WEBHOOK_BODY_MAX_BYTES`, 10/2048 =
 * `WEBHOOK_URL_MIN_LENGTH`/`_MAX_LENGTH`, 500 = `WEBHOOK_DESCRIPTION_MAX_LENGTH`, p_limit 1000 = `DEFINER_LIMIT_MAX`, tập
 * `last_error` = `LAST_ERRORS`.
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `organizations` (FK của `webhook_endpoints`),
 * ngắn. Down (mẫu "down có canh" của 3B/4B): từ chối khi còn endpoint hoặc secret (xoá chúng là mất cấu hình và secret của
 * khách, không khôi phục được); bỏ FORCE trước câu kiểm vì dưới FORCE app_owner thấy 0 dòng, `ALTER TABLE` lấy ACCESS
 * EXCLUSIVE giữ tới hết lô nên không ghi nào chen giữa câu kiểm và DROP. Còn bị FK RESTRICT chặn khi role tuỳ biến (3B) còn giữ
 * `webhooks.*` (lỗi to; runbook gỡ quyền khỏi role trước).
 */
export class Migration20261010032022_webhooks extends Migration {
  override name = 'Migration20261010032022_webhooks';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer') THEN
    RAISE EXCEPTION 'roles partition_owner/sweep_definer are missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE webhook_event_types (
    type TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_event_types_type_ck CHECK (type ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'));`);
    this.addSql(`GRANT SELECT ON webhook_event_types TO app_user;`);
    // Hợp đồng công khai (spec §8.3): sáu event tenancy có `webhook: true` (6.0). `WebhookEventCatalogueCheck` so lúc boot.
    this.addSql(`INSERT INTO webhook_event_types (type) VALUES
    ('tenancy.member.added'), ('tenancy.member.removed'), ('tenancy.member.role_changed'),
    ('tenancy.org.updated'), ('tenancy.org.deleted'), ('tenancy.org.restored');`);

    this.addSql(`CREATE TABLE webhook_endpoints (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    url TEXT NOT NULL,
    description TEXT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    disabled_reason TEXT NULL,
    failing_since TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL,
    purge_after TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoints_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT webhook_endpoints_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT webhook_endpoints_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT webhook_endpoints_url_ck CHECK (char_length(url) BETWEEN 10 AND 2048 AND url ~ '^https?://'),
    CONSTRAINT webhook_endpoints_description_ck CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500),
    CONSTRAINT webhook_endpoints_status_ck CHECK (status IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT webhook_endpoints_disabled_reason_ck CHECK (disabled_reason IN ('MANUAL', 'AUTO_FAILING')),
    CONSTRAINT webhook_endpoints_disabled_pair_ck CHECK ((status = 'DISABLED') = (disabled_reason IS NOT NULL)),
    CONSTRAINT webhook_endpoints_deleted_pair_ck CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
    CONSTRAINT webhook_endpoints_purge_after_ck CHECK (purge_after > deleted_at),
    CONSTRAINT webhook_endpoints_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE INDEX webhook_endpoints_live_idx ON webhook_endpoints (org_id) WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX webhook_endpoints_purge_idx ON webhook_endpoints (purge_after) WHERE deleted_at IS NOT NULL;`,
    );
    this.addSql(`ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY webhook_endpoints_tenant ON webhook_endpoints TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY webhook_endpoints_definer_read ON webhook_endpoints FOR SELECT TO sweep_definer USING (true);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON webhook_endpoints TO app_user;`,
    );
    this.addSql(
      `GRANT UPDATE (url, description, status, disabled_reason, failing_since, deleted_at, purge_after, version, updated_at) ON webhook_endpoints TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, purge_after, deleted_at) ON webhook_endpoints TO sweep_definer;`,
    );

    this.addSql(`CREATE TABLE webhook_endpoint_secrets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    secret_enc TEXT NOT NULL,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoint_secrets_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT webhook_endpoint_secrets_endpoint_fk FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_endpoint_secrets_enc_ck CHECK (secret_enc ~ '^v1\\.[a-z0-9]{1,16}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{22}$'));`);
    this.addSql(
      `CREATE UNIQUE INDEX webhook_endpoint_secrets_current_uq ON webhook_endpoint_secrets (org_id, endpoint_id) WHERE expires_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX webhook_endpoint_secrets_endpoint_idx ON webhook_endpoint_secrets (org_id, endpoint_id);`,
    );
    this.addSql(
      `ALTER TABLE webhook_endpoint_secrets ENABLE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE webhook_endpoint_secrets FORCE ROW LEVEL SECURITY;`,
    );
    this
      .addSql(`CREATE POLICY webhook_endpoint_secrets_tenant ON webhook_endpoint_secrets TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON webhook_endpoint_secrets TO app_user;`,
    );
    this.addSql(
      `GRANT UPDATE (expires_at, updated_at) ON webhook_endpoint_secrets TO app_user;`,
    );
    // M5 (review bảo mật 6C): sweep xoá secret đã hết hạn (hàm quét xuyên org + xoá theo org), index theo đúng câu đó.
    this.addSql(
      `CREATE INDEX webhook_endpoint_secrets_expiry_idx ON webhook_endpoint_secrets (expires_at) WHERE expires_at IS NOT NULL;`,
    );
    this.addSql(
      `CREATE POLICY webhook_endpoint_secrets_definer_read ON webhook_endpoint_secrets FOR SELECT TO sweep_definer USING (true);`,
    );
    this.addSql(
      `GRANT SELECT (org_id, expires_at) ON webhook_endpoint_secrets TO sweep_definer;`,
    );

    this.addSql(`CREATE TABLE webhook_endpoint_event_types (
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoint_event_types_pk PRIMARY KEY (org_id, endpoint_id, event_type),
    CONSTRAINT webhook_endpoint_event_types_endpoint_fk FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_endpoint_event_types_type_fk FOREIGN KEY (event_type) REFERENCES webhook_event_types (type) ON DELETE RESTRICT);`);
    this.addSql(
      `CREATE INDEX webhook_endpoint_event_types_org_type_idx ON webhook_endpoint_event_types (org_id, event_type);`,
    );
    this.addSql(
      `CREATE INDEX webhook_endpoint_event_types_type_idx ON webhook_endpoint_event_types (event_type);`,
    );
    this.addSql(
      `ALTER TABLE webhook_endpoint_event_types ENABLE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE webhook_endpoint_event_types FORCE ROW LEVEL SECURITY;`,
    );
    this
      .addSql(`CREATE POLICY webhook_endpoint_event_types_tenant ON webhook_endpoint_event_types TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON webhook_endpoint_event_types TO app_user;`,
    );

    // R-X27, R-X33: partition_owner không nhận REFERENCES trên bảng thường nào (không FK partitioned → bảng thường).
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`CREATE TABLE webhook_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    event_version INT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_messages_pk PRIMARY KEY (created_at, id),
    CONSTRAINT webhook_messages_org_id_uq UNIQUE (org_id, id, created_at),
    CONSTRAINT webhook_messages_event_type_ck CHECK (event_type ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' OR event_type = 'webhook.test'),
    CONSTRAINT webhook_messages_event_version_ck CHECK (event_version > 0),
    CONSTRAINT webhook_messages_body_ck CHECK (octet_length(body) <= 262144)) PARTITION BY RANGE (created_at);`);
    this.addSql(
      `CREATE INDEX webhook_messages_org_created_idx ON webhook_messages (org_id, created_at);`,
    );
    this.addSql(`ALTER TABLE webhook_messages ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_messages FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY webhook_messages_tenant ON webhook_messages TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    // Message bất biến sau khi ghi: không grant UPDATE.
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON webhook_messages TO app_user;`,
    );

    this.addSql(`CREATE TABLE webhook_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    public_id UUID NOT NULL,
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    status TEXT NOT NULL,
    attempts_total INT NOT NULL DEFAULT 0,
    cycle_base INT NOT NULL DEFAULT 0,
    local_failures INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NULL,
    lease_until TIMESTAMPTZ NULL,
    last_attempt_at TIMESTAMPTZ NULL,
    last_status_code INT NULL,
    last_error TEXT NULL,
    completed_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_pk PRIMARY KEY (created_at, id),
    CONSTRAINT webhook_deliveries_public_id_uq UNIQUE (public_id, created_at),
    CONSTRAINT webhook_deliveries_message_endpoint_uq UNIQUE (org_id, message_id, created_at, endpoint_id),
    CONSTRAINT webhook_deliveries_message_fk FOREIGN KEY (org_id, message_id, created_at) REFERENCES public.webhook_messages (org_id, id, created_at) ON DELETE RESTRICT,
    CONSTRAINT webhook_deliveries_status_ck CHECK (status IN ('PENDING', 'SENDING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'EXHAUSTED', 'CANCELLED')),
    CONSTRAINT webhook_deliveries_cycle_ck CHECK (0 <= cycle_base AND cycle_base <= attempts_total),
    CONSTRAINT webhook_deliveries_local_failures_ck CHECK (local_failures >= 0),
    CONSTRAINT webhook_deliveries_next_attempt_ck CHECK ((status IN ('PENDING', 'RETRY_SCHEDULED')) = (next_attempt_at IS NOT NULL)),
    CONSTRAINT webhook_deliveries_lease_ck CHECK ((status = 'SENDING') = (lease_until IS NOT NULL)),
    CONSTRAINT webhook_deliveries_status_code_ck CHECK (last_status_code BETWEEN 100 AND 599),
    CONSTRAINT webhook_deliveries_last_error_ck CHECK (last_error IN ('TIMEOUT', 'NETWORK', 'SERVER_ERROR', 'CLIENT_ERROR', 'REDIRECT', 'RATE_LIMITED', 'SSRF_BLOCKED', 'TOO_LARGE', 'BULKHEAD_FULL', 'CIRCUIT_OPEN', 'LEASE_EXPIRED', 'SECRET_UNAVAILABLE', 'DNS_UNAVAILABLE', 'ENDPOINT_UNAVAILABLE')),
    CONSTRAINT webhook_deliveries_completed_ck CHECK ((status IN ('SUCCEEDED', 'EXHAUSTED', 'CANCELLED')) = (completed_at IS NOT NULL)),
    CONSTRAINT webhook_deliveries_version_ck CHECK (version >= 1)) PARTITION BY RANGE (created_at);`);
    this.addSql(
      `CREATE INDEX webhook_deliveries_endpoint_created_idx ON webhook_deliveries (org_id, endpoint_id, created_at DESC, public_id DESC);`,
    );
    this.addSql(
      `CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('PENDING', 'RETRY_SCHEDULED');`,
    );
    this.addSql(
      `CREATE INDEX webhook_deliveries_lease_idx ON webhook_deliveries (lease_until) WHERE status = 'SENDING';`,
    );
    this.addSql(
      `CREATE INDEX webhook_deliveries_endpoint_status_idx ON webhook_deliveries (org_id, endpoint_id, status, created_at);`,
    );
    this.addSql(`ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY webhook_deliveries_definer_read ON webhook_deliveries FOR SELECT TO sweep_definer USING (true);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON webhook_deliveries TO app_user;`,
    );
    this.addSql(
      `GRANT UPDATE (status, attempts_total, cycle_base, local_failures, next_attempt_at, lease_until, last_attempt_at, last_status_code, last_error, completed_at, version, updated_at) ON webhook_deliveries TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, status, next_attempt_at, lease_until) ON webhook_deliveries TO sweep_definer;`,
    );

    // Hàm bảo trì (spec §6.7; mẫu của fixture 6.0): lock_timeout là thuộc tính hàm; drop deliveries trước messages (spike P2).
    this
      .addSql(`CREATE FUNCTION public.webhook_partitions_maintain(p_retention_months integer, p_premake_months integer)
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
    RAISE EXCEPTION 'webhook_partitions_maintain: arguments must not be NULL';
  END IF;
  -- Sàn retention cứng ở đây (WEBHOOK_RETENTION_MIN_MONTHS): SQLi bằng app_user không hạ được dưới sàn.
  IF p_retention_months < 1 OR p_retention_months > 120 THEN
    RAISE EXCEPTION 'webhook_partitions_maintain: p_retention_months must be between 1 and 120';
  END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN
    RAISE EXCEPTION 'webhook_partitions_maintain: p_premake_months must be between 1 and 12';
  END IF;
  -- R6-17: một lượt mỗi lúc (WEBHOOK_PARTITIONS_LOCK_KEY); lượt thứ hai là no-op.
  IF NOT pg_try_advisory_xact_lock(6002) THEN RETURN; END IF;
  -- Mốc tháng theo UTC, không theo TimeZone của session.
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOREACH v_table IN ARRAY ARRAY['webhook_messages', 'webhook_deliveries'] LOOP
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
  v_cutoff := v_base - make_interval(months => p_retention_months);
  -- Spike P2: partition deliveries của tháng M đi trước partition messages cùng tháng (FK deliveries → messages).
  FOREACH v_table IN ARRAY ARRAY['webhook_deliveries', 'webhook_messages'] LOOP
    FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = ('public.' || v_table)::regclass ORDER BY c.relname LOOP
      IF r.relname !~ ('^' || v_table || '_p[0-9]{6}$') THEN
        RAISE EXCEPTION 'webhook_partitions_maintain: unexpected partition %', r.relname;
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
      `REVOKE ALL ON FUNCTION public.webhook_partitions_maintain(integer, integer) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.webhook_partitions_maintain(integer, integer) TO app_user;`,
    );
    // Partition đầu (tháng hiện tại + 3 tháng tới = mặc định INTEGRATIONS_PARTITION_PREMAKE_MONTHS) do chính hàm tạo.
    this.addSql(
      `SELECT count(*) FROM public.webhook_partitions_maintain(1, 3);`,
    );
    this.addSql(`RESET ROLE;`);

    // Hàm quét xuyên org (spec §6.8, R-X4, R-X14): owner sweep_definer, chữ ký (p_after, p_limit) + p_grace_sec theo tên.
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this
      .addSql(`CREATE FUNCTION public.integrations_orgs_due(p_after uuid, p_limit integer, p_grace_sec integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_grace_sec IS NULL THEN
    RAISE EXCEPTION 'integrations_orgs_due: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'integrations_orgs_due: p_limit must be between 1 and 1000'; END IF;
  IF p_grace_sec < 1 OR p_grace_sec > 86400 THEN
    RAISE EXCEPTION 'integrations_orgs_due: p_grace_sec must be between 1 and 86400';
  END IF;
  RETURN QUERY
    SELECT u.org_id FROM (
      SELECT d.org_id FROM public.webhook_deliveries d
       WHERE d.status IN ('PENDING', 'RETRY_SCHEDULED') AND d.next_attempt_at <= now() - make_interval(secs => p_grace_sec)
         AND d.org_id > p_after
      UNION
      SELECT d.org_id FROM public.webhook_deliveries d
       WHERE d.status = 'SENDING' AND d.lease_until <= now() - make_interval(secs => p_grace_sec) AND d.org_id > p_after
      UNION
      SELECT e.org_id FROM public.webhook_endpoints e
       WHERE e.deleted_at IS NOT NULL AND e.purge_after <= now() AND e.org_id > p_after
      UNION
      SELECT s.org_id FROM public.webhook_endpoint_secrets s
       WHERE s.expires_at IS NOT NULL AND s.expires_at <= now() AND s.org_id > p_after
    ) u
    ORDER BY u.org_id LIMIT p_limit;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.integrations_orgs_due(uuid, integer, integer) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.integrations_orgs_due(uuid, integer, integer) TO app_user;`,
    );
    this.addSql(`RESET ROLE;`);

    // Catalogue `integrations` (spec §9.1): `CatalogueCheck` của tenancy so với `WebhookPermissions` lúc boot (Task 5).
    this
      .addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('webhooks', 'read', false, true, true),
    ('webhooks', 'write', false, false, false);`);
    this
      .addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'webhooks.read' WHERE p.key = 'webhooks.write';`);
  }

  override down(): void | Promise<void> {
    // Down có canh (mẫu 3B/4B): dưới FORCE app_owner không có policy nên thấy 0 dòng; bỏ FORCE để câu kiểm thấy thật.
    // ALTER TABLE lấy ACCESS EXCLUSIVE giữ tới hết lô: tạo endpoint/xoay secret đang mở thì down chờ nó, rồi thấy dòng của nó.
    // RAISE → cả lô rollback, FORCE còn nguyên.
    this.addSql(
      `ALTER TABLE public.webhook_endpoints NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE public.webhook_endpoint_secrets NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_endpoints) OR EXISTS (SELECT 1 FROM public.webhook_endpoint_secrets) THEN
    RAISE EXCEPTION 'webhook endpoints or secrets exist; reverting the webhooks migration would destroy customer webhook configuration and signing secrets';
  END IF;
END $$;`);
    this.addSql(
      `DELETE FROM permission_requires WHERE permission_id = (SELECT id FROM permissions WHERE key = 'webhooks.write');`,
    );
    this.addSql(
      `DELETE FROM permissions WHERE key IN ('webhooks.write', 'webhooks.read');`,
    );
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(
      `DROP FUNCTION public.integrations_orgs_due(uuid, integer, integer);`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`DROP TABLE webhook_deliveries;`);
    this.addSql(`DROP TABLE webhook_messages;`);
    this.addSql(
      `DROP FUNCTION public.webhook_partitions_maintain(integer, integer);`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE webhook_endpoint_event_types;`);
    this.addSql(`DROP TABLE webhook_endpoint_secrets;`);
    this.addSql(`DROP TABLE webhook_endpoints;`);
    this.addSql(`DROP TABLE webhook_event_types;`);
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
