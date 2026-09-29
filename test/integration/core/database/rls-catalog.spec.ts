import { Client } from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_TABLES } from '../../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { getInfra } from '../../../support/infra.js';
import {
  DEFINER_FUNCTIONS,
  DEFINER_INTERNAL_FUNCTIONS,
  DEFINER_READ_TABLES,
  DEFINER_TRIGGER_FUNCTIONS,
  TENANCY_TENANT_TABLES,
} from '../../../support/tenancy-catalog.js';

// R10: these infrastructure tables are protected by per-table grants instead of RLS.
const INFRASTRUCTURE_TABLES = ['outbox_events', 'processed_events'];
// Derived from the checked-in migrations; live catalog confirmation requires Docker.
const GLOBAL_TABLES = [
  'mikro_orm_migrations',
  'mikro_orm_migrations_fixtures',
  'outbox_events',
  'processed_events',
  'fixture_notes',
  'fixture_parents',
  'fixture_children',
  'fixture_no_grant',
  // global: email giao dịch của auth, không thuộc org (spec SP2 §5.11)
  'email_deliveries',
  // global: bảng tra cứu template (spec SP3 §6.13)
  'email_templates',
  // SP3 (spec §6.2–6.3): registry principal và catalogue quyền, không chứa dữ liệu tenant
  'tenancy_users',
  'permissions',
  'permission_requires',
];
/** Bảng gốc tenant (spec SP3 §18.1): không có cột `org_id`, policy dùng `app_current_org()` trên `id`. */
const ORG_ROOT_TABLES = ['organizations'];

interface TableRow {
  name: string;
  has_org: boolean;
  rls: boolean;
  force_rls: boolean;
  org_policy: boolean;
}

async function tables(client: Client, schema = 'public'): Promise<TableRow[]> {
  const result = await client.query<TableRow>(
    `
    SELECT c.relname AS name, c.relrowsecurity AS rls,
      c.relforcerowsecurity AS force_rls,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_org,
      EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname
        AND p.tablename = c.relname
        AND (p.qual LIKE '%app_current_org()%'
          OR p.with_check LIKE '%app_current_org()%')) AS org_policy
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname
  `,
    [schema],
  );
  return result.rows;
}

function assertTenantSecurity(rows: TableRow[]): void {
  const failures = rows.filter(
    (row) =>
      row.has_org &&
      !INFRASTRUCTURE_TABLES.includes(row.name) &&
      !(row.rls && row.force_rls && row.org_policy),
  );
  expect(
    failures,
    'org_id tables require RLS, FORCE RLS and an org policy',
  ).toEqual([]);
}

/**
 * Review M5 / quy ước B5: cột `org_id` phải có đường FK tới `organizations(id)`, trực tiếp hoặc qua FK kép
 * `(org_id, …) → cha (org_id, …)` mà cha có đường đó (ví dụ `org_members` → `org_roles` → `organizations`). Thiếu
 * đường thì purge để lại dòng mồ côi (vô hình dưới RLS) mà không báo gì. Ngoại lệ ghi lý do: `{ bảng: lý do }`.
 */
const ORG_FK_EXEMPT: Readonly<Record<string, string>> = {
  outbox_events:
    'hạ tầng (R10), không phải dữ liệu tenant: org_id là metadata của event, và tenancy.org.purged phải sống lâu hơn org',
  fixture_org_notes:
    'fixture SP1 có trước organizations: test RLS của SP1 chèn org_id tuỳ ý, không cần org thật',
};

async function orgIdWithoutOrgFk(
  client: Client,
  schema = 'public',
): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `
    WITH RECURSIVE anchored(relid) AS (
      SELECT 'public.organizations'::regclass::oid
      UNION
      SELECT k.conrelid
      FROM anchored an
      JOIN pg_constraint k ON k.contype = 'f' AND k.confrelid = an.relid
      CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS m(src, dst)
      JOIN pg_attribute s ON s.attrelid = k.conrelid AND s.attnum = m.src
        AND s.attname = 'org_id'
      JOIN pg_attribute t ON t.attrelid = k.confrelid AND t.attnum = m.dst
        AND t.attname = CASE WHEN k.confrelid = 'public.organizations'::regclass
          THEN 'id' ELSE 'org_id' END
    )
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
      AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      AND c.oid NOT IN (SELECT relid FROM anchored)
    ORDER BY c.relname
  `,
    [schema],
  );
  return rows.map((r) => r.name).filter((name) => !(name in ORG_FK_EXEMPT));
}

describe('RLS catalog (owner connection after global migrations)', () => {
  let client: Client;
  beforeAll(async () => {
    const { pg } = getInfra();
    client = new Client({
      host: pg.host,
      port: pg.port,
      database: pg.database,
      ...pg.owner,
    });
    await client.connect();
    const result = await client.query<{ role: string }>(
      'SELECT current_user AS role',
    );
    expect(result.rows[0]?.role).toBe('app_owner');
  });
  afterAll(async () => {
    await client?.end();
  });

  it('protects every tenant table and explicitly inventories global tables', async () => {
    const rows = await tables(client);
    expect(rows.length).toBeGreaterThan(0);
    assertTenantSecurity(rows);
    expect(
      rows.filter(
        (row) =>
          !row.has_org &&
          !GLOBAL_TABLES.includes(row.name) &&
          !ORG_ROOT_TABLES.includes(row.name),
      ),
    ).toEqual([]);
    expect(
      rows
        .filter((row) => ORG_ROOT_TABLES.includes(row.name))
        .map((r) => ({
          name: r.name,
          rls: r.rls,
          force: r.force_rls,
          policy: r.org_policy,
        })),
    ).toEqual(
      ORG_ROOT_TABLES.map((name) => ({
        name,
        rls: true,
        force: true,
        policy: true,
      })),
    );
    expect(
      rows
        .filter((row) => INFRASTRUCTURE_TABLES.includes(row.name))
        .map((row) => ({
          name: row.name,
          rls: row.rls,
          force_rls: row.force_rls,
        })),
    ).toEqual(
      INFRASTRUCTURE_TABLES.map((name) => ({
        name,
        rls: false,
        force_rls: false,
      })),
    );
  });

  it('schema auth holds only the Better Auth allowlist, without org_id and without RLS policies', async () => {
    const rows = await tables(client, 'auth');
    expect(rows.map((r) => r.name).sort()).toEqual([...AUTH_TABLES].sort());
    expect(rows.filter((r) => r.has_org || r.org_policy)).toEqual([]);
  });

  it('allows USING (true) only for SELECT TO app_relay, or SELECT TO tenancy_definer on the declared tables', async () => {
    const { rows } = await client.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
      qual: string | null;
    }>(
      `SELECT tablename, policyname, cmd, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'public'`,
    );
    const unrestricted = rows.filter(
      (row) => row.qual?.replace(/[()\s]/g, '').toLowerCase() === 'true',
    );
    expect(
      unrestricted.some((row) => row.tablename === 'scheduled_tasks'),
    ).toBe(true);
    for (const policy of unrestricted) {
      const definer =
        policy.roles.length === 1 && policy.roles[0] === 'tenancy_definer';
      expect(policy.cmd, policy.policyname).toBe('SELECT');
      if (definer)
        expect(DEFINER_READ_TABLES, policy.policyname).toContain(
          policy.tablename,
        );
      else expect(policy.roles, policy.policyname).toEqual(['app_relay']);
    }
    expect(
      unrestricted
        .filter((p) => p.roles[0] === 'tenancy_definer')
        .map((p) => p.tablename)
        .sort(),
    ).toEqual([...DEFINER_READ_TABLES].sort());
  });
  it('every tenant policy of tenancy tables is limited TO app_user (never PUBLIC, S3-A3)', async () => {
    const { rows } = await client.query<{ tablename: string; roles: string[] }>(
      `SELECT tablename, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND policyname = tablename || '_tenant' AND tablename = ANY($1::text[])`,
      [['organizations', ...TENANCY_TENANT_TABLES]],
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual(
      ['organizations', ...TENANCY_TENANT_TABLES].sort(),
    );
    for (const r of rows) expect(r.roles, r.tablename).toEqual(['app_user']);
  });
  it('a deferrable constraint name is unique per schema (R4C-N4-4, R5-C1)', async () => {
    const { rows } = await client.query(
      `SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname IN ('public', 'auth') GROUP BY n.nspname, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)`,
    );
    expect(rows).toEqual([]);
  });

  it('no application role bypasses RLS (and all five roles exist)', async () => {
    const { rows } = await client.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolbypassrls FROM pg_roles
      WHERE rolname IN ('app_user', 'app_relay', 'app_owner', 'auth_user', 'tenancy_definer')
      ORDER BY rolname
    `);
    expect(rows).toEqual(
      [
        'app_owner',
        'app_relay',
        'app_user',
        'auth_user',
        'tenancy_definer',
      ].map((rolname) => ({
        rolname,
        rolbypassrls: false,
      })),
    );
  });

  it('tenancy_definer cannot log in and app_owner holds it WITH INHERIT FALSE, SET TRUE (spec §6.13, T2)', async () => {
    const { rows } = await client.query(
      `SELECT r.rolcanlogin, m.inherit_option, m.set_option
       FROM pg_roles r
       JOIN pg_auth_members m ON m.roleid = r.oid
       JOIN pg_roles u ON u.oid = m.member AND u.rolname = 'app_owner'
       WHERE r.rolname = 'tenancy_definer'`,
    );
    expect(rows).toEqual([
      { rolcanlogin: false, inherit_option: false, set_option: true },
    ]);
  });

  it('M5 / B5: every public table with org_id has an FK from org_id to organizations(id), apart from the reasoned allowlist', async () => {
    expect(await orgIdWithoutOrgFk(client)).toEqual([]);
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [Object.keys(ORG_FK_EXEMPT)],
    );
    // Một ngoại lệ trỏ tới bảng không còn tồn tại là lỗi thời, phải xoá khỏi danh sách.
    expect(rows.map((r) => r.name).toSorted()).toEqual(
      Object.keys(ORG_FK_EXEMPT).toSorted(),
    );
  });

  it('the org FK check flags an org_id table without a path to organizations and accepts direct and composite paths (probe rolled back)', async () => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE org_fk_probe_missing (org_id uuid)');
      await client.query(
        'CREATE TABLE org_fk_probe_direct (org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT)',
      );
      await client.query(
        `CREATE TABLE org_fk_probe_composite (org_id uuid NOT NULL, role_id bigint NOT NULL,
           FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE RESTRICT)`,
      );
      // FK tới organizations trên cột khác: org_id vẫn không có đường.
      await client.query(
        'CREATE TABLE org_fk_probe_other_column (org_id uuid, other_org uuid REFERENCES organizations (id))',
      );
      expect(await orgIdWithoutOrgFk(client)).toEqual([
        'org_fk_probe_missing',
        'org_fk_probe_other_column',
      ]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('rejects an org_id table without RLS and rolls the probe back', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        'CREATE TEMP TABLE rls_catalog_negative_probe (org_id uuid)',
      );
      const { rows } = await client.query<{ schema: string }>(
        'SELECT nspname AS schema FROM pg_namespace WHERE oid = pg_my_temp_schema()',
      );
      const probe = await tables(client, rows[0]!.schema);
      expect(
        probe.some((row) => row.name === 'rls_catalog_negative_probe'),
      ).toBe(true);
      expect(() => assertTenantSecurity(probe)).toThrow(
        /org_id tables require/,
      );
    } finally {
      await client.query('ROLLBACK');
    }
    const { rows } = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('pg_temp.rls_catalog_negative_probe')::text AS relation",
    );
    expect(rows[0]?.relation).toBeNull();
  });
});

type Priv = {
  role: string;
  public_usage: boolean;
  public_create: boolean;
  auth_usage: boolean;
  auth_create: boolean;
  db_connect: boolean;
  db_temp: boolean;
};
const EXPECTED_PRIVS: Priv[] = [
  {
    role: 'public',
    public_usage: false,
    public_create: false,
    auth_usage: false,
    auth_create: false,
    db_connect: false,
    db_temp: false,
  },
  {
    role: 'app_user',
    public_usage: true,
    public_create: false,
    auth_usage: false,
    auth_create: false,
    db_connect: true,
    db_temp: false,
  },
  {
    role: 'app_relay',
    public_usage: true,
    public_create: false,
    auth_usage: false,
    auth_create: false,
    db_connect: true,
    db_temp: false,
  },
  {
    role: 'auth_user',
    public_usage: false,
    public_create: false,
    auth_usage: true,
    auth_create: false,
    db_connect: true,
    db_temp: false,
  },
  {
    role: 'tenancy_definer',
    public_usage: true,
    public_create: true,
    auth_usage: false,
    auth_create: false,
    db_connect: false,
    db_temp: false,
  },
  {
    role: 'app_owner',
    public_usage: true,
    public_create: true,
    auth_usage: true,
    auth_create: true,
    db_connect: true,
    db_temp: true,
  },
];

async function privilegeMatrix(client: Client): Promise<Priv[]> {
  const rows: Priv[] = [];
  for (const { role } of EXPECTED_PRIVS) {
    const r = await client.query<Priv>(
      `SELECT $1::text AS role,
         has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
         has_schema_privilege($1, 'public', 'CREATE') AS public_create,
         has_schema_privilege($1, 'auth', 'USAGE') AS auth_usage,
         has_schema_privilege($1, 'auth', 'CREATE') AS auth_create,
         has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
         has_database_privilege($1, current_database(), 'TEMPORARY') AS db_temp`,
      [role],
    );
    rows.push(r.rows[0]!);
  }
  return rows;
}

describe('schema and database privileges (R20)', () => {
  let client: Client;
  beforeAll(async () => {
    const { pg } = getInfra();
    client = new Client({
      host: pg.host,
      port: pg.port,
      database: pg.database,
      ...pg.owner,
    });
    await client.connect();
  });
  afterAll(async () => client?.end());

  it('matches the expected matrix for PUBLIC and every application role', async () => {
    expect(await privilegeMatrix(client)).toEqual(EXPECTED_PRIVS);
  });

  it('the SECURITY DEFINER set in public equals the callable definer functions ∪ the trigger functions; each callable one is STABLE, owned by tenancy_definer, search_path="", EXECUTE for app_user only', async () => {
    const { rows } = await client.query<{
      name: string;
      owner: string;
      config: string[] | null;
      volatility: string;
      app: boolean;
      pub: boolean;
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              p.provolatile AS volatility,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
    );
    // Ba hàm trigger hoãn (Task 13) cũng là SECURITY DEFINER nhưng không ai EXECUTE được; test "internal tenancy_definer
    // functions" phủ chúng. Ở đây khẳng định tập SECURITY DEFINER = hàm gọi được ∪ hàm trigger, không dư hàm nào.
    expect(rows.map((r) => r.name)).toEqual(
      [...DEFINER_FUNCTIONS, ...DEFINER_TRIGGER_FUNCTIONS].sort(),
    );
    for (const r of rows.filter((x) => DEFINER_FUNCTIONS.includes(x.name)))
      expect(r, r.name).toMatchObject({
        owner: 'tenancy_definer',
        config: ['search_path=""'],
        // Chỉ đọc (spec §6.14): STABLE.
        volatility: 's',
        app: true,
        pub: false,
      });
  });
  it('PUBLIC holds EXECUTE on no function in public', async () => {
    const { rows } = await client.query(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });

  it('auth_user cannot EXECUTE any function in public', async () => {
    // Fails when a migration creates a function in public without revoking the EXECUTE that PostgreSQL
    // grants to PUBLIC by default (spec §5.3: auth_user has no privilege on any function in public).
    const { rows } = await client.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('auth_user', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });

  it('functions app_owner creates in public or auth do not grant EXECUTE to PUBLIC', async () => {
    await client.query('BEGIN');
    try {
      const probes = ['public.acl_probe_fn', 'auth.acl_probe_fn'];
      for (const fn of probes) {
        await client.query(
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        );
      }
      const { rows } = await client.query<{ fn: string; pub: boolean }>(
        `SELECT fn, has_function_privilege('public', fn || '()', 'EXECUTE') AS pub
         FROM unnest($1::text[]) fn`,
        [probes],
      );
      expect(rows).toEqual(probes.map((fn) => ({ fn, pub: false })));
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('re-running the init script succeeds and leaves every privilege unchanged (S2-R18)', async () => {
    const runtime = await getContainerRuntimeClient();
    const container = runtime.container.getById(getInfra().pg.containerId);
    const result = await runtime.container.exec(container, [
      'bash',
      '/docker-entrypoint-initdb.d/01-roles.sh',
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(await privilegeMatrix(client)).toEqual(EXPECTED_PRIVS);
    const { rows } = await client.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper',
    );
    expect(rows).toEqual([]);
    const owner = await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'auth'`,
    );
    expect(owner.rows).toEqual([{ owner: 'app_owner' }]);
  });

  it('auth_user is NOBYPASSRLS, not superuser, with search_path = auth', async () => {
    const { rows } = await client.query(
      `SELECT r.rolbypassrls, r.rolsuper,
         (SELECT array_agg(c) FROM unnest(s.setconfig) c WHERE c LIKE 'search_path=%') AS sp
       FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
       WHERE r.rolname = 'auth_user'`,
    );
    expect(rows[0]).toEqual({
      rolbypassrls: false,
      rolsuper: false,
      sp: ['search_path=auth'],
    });
  });

  it('schema auth is owned by app_owner', async () => {
    const { rows } = await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'auth'`,
    );
    expect(rows).toEqual([{ owner: 'app_owner' }]);
  });

  it('auth_user holds no privilege on any relation or column in public', async () => {
    // Defence in depth (spec §5.3): the missing USAGE on public already blocks access (roles.spec),
    // but a table or column grant to auth_user would leak as soon as someone granted USAGE.
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         AND (has_table_privilege('auth_user', c.oid,
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           OR has_any_column_privilege('auth_user', c.oid,
                'SELECT, INSERT, UPDATE, REFERENCES'))`,
    );
    expect(rows).toEqual([]);
  });

  it('no role other than a superuser has BYPASSRLS', async () => {
    const { rows } = await client.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper',
    );
    expect(rows).toEqual([]);
  });

  describe('tenancy grants (spec SP3 §6.2–6.6, §18.1)', () => {
    it('internal tenancy_definer functions: owner, SECURITY DEFINER triggers, empty search_path, no EXECUTE for callers (spec §6.4, §6.6)', async () => {
      const { rows } = await client.query<{
        name: string;
        owner: string;
        secdef: boolean;
        config: string[] | null;
        volatility: string;
        app_user: boolean;
        app_relay: boolean;
        pub: boolean;
        app_owner: boolean;
      }>(
        `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
           p.proconfig AS config, p.provolatile AS volatility,
           has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
           has_function_privilege('app_relay', p.oid, 'EXECUTE') AS app_relay,
           has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
           has_function_privilege('app_owner', p.oid, 'EXECUTE') AS app_owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
        [[...DEFINER_INTERNAL_FUNCTIONS]],
      );
      expect(rows.map((r) => r.name)).toEqual(
        [...DEFINER_INTERNAL_FUNCTIONS].sort(),
      );
      for (const r of rows) {
        const trigger = DEFINER_TRIGGER_FUNCTIONS.includes(r.name);
        expect(r, r.name).toEqual({
          name: r.name,
          owner: 'tenancy_definer',
          secdef: trigger,
          config: ['search_path=""'],
          // Hàm trigger phải VOLATILE: dưới READ COMMITTED mỗi câu trong hàm volatile lấy snapshot mới, nên câu đếm owner
          // sau `pg_advisory_xact_lock` thấy phần bên kia vừa commit (T-28). Hàm khoá là IMMUTABLE (băm thuần).
          volatility: trigger ? 'v' : 'i',
          app_user: false,
          app_relay: false,
          pub: false,
          // CREATE TRIGGER (chạy bằng app_owner) đòi EXECUTE trên hàm trigger; lúc trigger bắn thì không kiểm EXECUTE.
          app_owner: trigger,
        });
      }
    });
    it('tenancy_definer holds only column SELECT on the declared columns', async () => {
      const { rows } = await client.query<{
        table_name: string;
        column_name: string;
        privilege_type: string;
      }>(
        `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
         WHERE grantee = 'tenancy_definer' AND table_schema = 'public' ORDER BY table_name, column_name`,
      );
      expect(rows.every((r) => r.privilege_type === 'SELECT')).toBe(true);
      const cols = (t: string) =>
        rows
          .filter((r) => r.table_name === t)
          .map((r) => r.column_name)
          .sort();
      expect(cols('organizations')).toEqual([
        'created_by_user_id',
        'deleted_at',
        'id',
        'name',
        'purge_after',
      ]);
      expect(cols('org_roles')).toEqual([
        'id',
        'name',
        'org_id',
        'public_id',
        'system_key',
      ]);
      expect(cols('org_members')).toEqual([
        'created_at',
        'id',
        'org_id',
        'public_id',
        'role_id',
        'user_id',
      ]);
      const tableLevel = await client.query(
        `SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'tenancy_definer'`,
      );
      expect(tableLevel.rows).toEqual([]);
    });
    it('app_user UPDATE is column-scoped: identity columns are immutable (spec §6.1)', async () => {
      const { rows } = await client.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name FROM information_schema.column_privileges
         WHERE grantee = 'app_user' AND privilege_type = 'UPDATE' AND table_schema = 'public'
           AND table_name IN ('tenancy_users', 'organizations', 'org_roles', 'org_members', 'permissions', 'permission_requires')
         ORDER BY table_name, column_name`,
      );
      const cols = (t: string) =>
        rows.filter((r) => r.table_name === t).map((r) => r.column_name);
      expect(cols('tenancy_users')).toEqual(['updated_at']);
      expect(cols('organizations')).toEqual([
        'created_by_user_id',
        'deleted_at',
        'name',
        'purge_after',
        'updated_at',
        'version',
      ]);
      expect(cols('org_roles')).toEqual([
        'description',
        'name',
        'updated_at',
        'version',
      ]);
      expect(cols('org_members')).toEqual(['role_id', 'updated_at', 'version']);
      expect(cols('permissions')).toEqual([]);
      expect(cols('permission_requires')).toEqual([]);
    });
  });
});
