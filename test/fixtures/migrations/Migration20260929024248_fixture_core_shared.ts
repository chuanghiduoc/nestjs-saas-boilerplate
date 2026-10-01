import { Migration } from '@mikro-orm/migrations';

/**
 * Fixture của plan SP6 6.0 (spec SP6 §6.7, §6.8, §16 C-5, C-8b): một bảng tenant có hàm quét xuyên org của `sweep_definer`, và
 * một bảng partitioned của `partition_owner` với hàm bảo trì theo đúng mẫu mà 6B/6C viết cho bảng thật. Không có FK tới
 * `organizations` (dòng append-only không xoá được, sẽ chặn `seedOrg().dispose()`; FK dưới `partition_owner` đã đo ở spike P1).
 * Index: `fixture_sweep_items_tag_org_idx (tag, org_id)` → câu của `fixture_orgs_due` (lọc tag, keyset theo org);
 * `fixture_part_events_org_idx (org_id, recorded_at)` → RLS + đọc theo org, khai trên cha nên nhân bản sang partition.
 * `lockKey` 6900 (6001 audit, 6002 webhook — spec §6.7).
 */
export class Migration20260929024248_fixture_core_shared extends Migration {
  override name = 'Migration20260929024248_fixture_core_shared';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_owner') THEN
    RAISE EXCEPTION 'roles sweep_definer/partition_owner are missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE fixture_sweep_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    tag TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(
      `CREATE INDEX fixture_sweep_items_tag_org_idx ON fixture_sweep_items (tag, org_id);`,
    );
    this.addSql(`ALTER TABLE fixture_sweep_items ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_sweep_items FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY fixture_sweep_items_tenant ON fixture_sweep_items TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY fixture_sweep_items_definer_read ON fixture_sweep_items FOR SELECT TO sweep_definer USING (true);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON fixture_sweep_items TO app_user;`,
    );
    this.addSql(
      `GRANT SELECT (org_id, tag, due_at) ON fixture_sweep_items TO sweep_definer;`,
    );

    // Hàm quét: owner sweep_definer (R-X4), chữ ký cố định (p_after, p_limit) + tham số thêm theo tên (R-X14).
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this
      .addSql(`CREATE FUNCTION public.fixture_orgs_due(p_after uuid, p_limit integer, p_min_age_sec integer, p_tag text)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_min_age_sec IS NULL OR p_tag IS NULL THEN
    RAISE EXCEPTION 'fixture_orgs_due: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'fixture_orgs_due: p_limit must be between 1 and 1000'; END IF;
  IF p_min_age_sec < 0 OR p_min_age_sec > 86400 THEN
    RAISE EXCEPTION 'fixture_orgs_due: p_min_age_sec must be between 0 and 86400';
  END IF;
  RETURN QUERY
    SELECT DISTINCT i.org_id FROM public.fixture_sweep_items i
    WHERE i.tag = p_tag AND i.due_at <= now() - make_interval(secs => p_min_age_sec) AND i.org_id > p_after
    ORDER BY i.org_id LIMIT p_limit;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.fixture_orgs_due(uuid, integer, integer, text) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.fixture_orgs_due(uuid, integer, integer, text) TO app_user;`,
    );
    this.addSql(`RESET ROLE;`);

    // Bảng partitioned + hàm bảo trì: owner partition_owner; policy/grant/index/trigger khai trên cha (spec §6.1).
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`CREATE TABLE fixture_part_events (
    org_id UUID NOT NULL,
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    body TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (recorded_at, id)) PARTITION BY RANGE (recorded_at);`);
    this.addSql(
      `CREATE INDEX fixture_part_events_org_idx ON fixture_part_events (org_id, recorded_at);`,
    );
    this.addSql(`ALTER TABLE fixture_part_events ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_part_events FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY fixture_part_events_tenant ON fixture_part_events TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT ON fixture_part_events TO app_user;`);
    this
      .addSql(`CREATE FUNCTION public.fixture_part_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'fixture_part_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.fixture_part_events_append_only() FROM PUBLIC;`,
    );
    this
      .addSql(`CREATE TRIGGER fixture_part_events_append_only BEFORE UPDATE OR DELETE ON fixture_part_events
    FOR EACH ROW EXECUTE FUNCTION public.fixture_part_events_append_only();`);
    this
      .addSql(`CREATE FUNCTION public.fixture_part_events_maintain(p_retention_months integer, p_premake_months integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s' AS $$
#variable_conflict use_column
DECLARE
  v_base timestamp;
  v_lo timestamp;
  v_name text;
  v_cutoff timestamp;
  r record;
BEGIN
  IF p_retention_months IS NULL OR p_premake_months IS NULL THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: arguments must not be NULL';
  END IF;
  -- Sàn retention cứng ở đây: SQLi bằng app_user không hạ được retention dưới sàn.
  IF p_retention_months < 1 OR p_retention_months > 120 THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: p_retention_months must be between 1 and 120';
  END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: p_premake_months must be between 1 and 12';
  END IF;
  -- R6-17: một lượt mỗi lúc; lượt thứ hai là no-op.
  IF NOT pg_try_advisory_xact_lock(6900) THEN RETURN; END IF;
  -- lock_timeout 5 s là thuộc tính của hàm (mệnh đề SET ở đầu), không set_config trong thân: Postgres khôi phục nó khi
  -- hàm thoát, nên transaction của caller (lô migration allOrNothing, UnitOfWork của cron) giữ giá trị của mình.
  -- Mốc tháng theo UTC, không theo TimeZone của session (Review Focus 4).
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOR i IN 0..p_premake_months LOOP
    v_lo := v_base + make_interval(months => i);
    v_name := 'fixture_part_events_p' || to_char(v_lo, 'YYYYMM');
    IF to_regclass('public.' || v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.fixture_part_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name);
      EXECUTE format('ALTER TABLE public.fixture_part_events ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
        v_name, v_lo AT TIME ZONE 'UTC', (v_lo + interval '1 month') AT TIME ZONE 'UTC');
      action := 'created'; partition_name := v_name; RETURN NEXT;
    END IF;
  END LOOP;
  v_cutoff := v_base - make_interval(months => p_retention_months);
  FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.fixture_part_events'::regclass ORDER BY c.relname LOOP
    IF r.relname !~ '^fixture_part_events_p[0-9]{6}$' THEN
      RAISE EXCEPTION 'fixture_part_events_maintain: unexpected partition %', r.relname;
    END IF;
    v_lo := to_date(substring(r.relname FROM '[0-9]{6}$'), 'YYYYMM')::timestamp;
    IF v_lo + interval '1 month' <= v_cutoff THEN
      EXECUTE format('ALTER TABLE public.fixture_part_events DETACH PARTITION public.%I', r.relname);
      EXECUTE format('DROP TABLE public.%I', r.relname);
      action := 'dropped'; partition_name := r.relname; RETURN NEXT;
    END IF;
  END LOOP;
END $$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.fixture_part_events_maintain(integer, integer) FROM PUBLIC;`,
    );
    this.addSql(
      `GRANT EXECUTE ON FUNCTION public.fixture_part_events_maintain(integer, integer) TO app_user;`,
    );
    // Partition đầu (tháng hiện tại + 3 tháng tới) do chính hàm bảo trì tạo (spec §6.7).
    this.addSql(
      `SELECT count(*) FROM public.fixture_part_events_maintain(1, 3);`,
    );
    this.addSql(`RESET ROLE;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`DROP TABLE fixture_part_events;`);
    this.addSql(
      `DROP FUNCTION public.fixture_part_events_maintain(integer, integer);`,
    );
    this.addSql(`DROP FUNCTION public.fixture_part_events_append_only();`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(
      `DROP FUNCTION public.fixture_orgs_due(uuid, integer, integer, text);`,
    );
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE fixture_sweep_items;`);
  }
}
