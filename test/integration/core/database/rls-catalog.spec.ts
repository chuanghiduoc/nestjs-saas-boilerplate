import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';

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
];

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
      rows.filter((row) => !row.has_org && !GLOBAL_TABLES.includes(row.name)),
    ).toEqual([]);
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

  it('allows USING (true) only for SELECT TO app_relay', async () => {
    const { rows } = await client.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
      qual: string | null;
    }>(`SELECT tablename, policyname, cmd, roles::text[] AS roles, qual
        FROM pg_policies WHERE schemaname = 'public'`);
    const unrestricted = rows.filter(
      (row) => row.qual?.replace(/[()\s]/g, '').toLowerCase() === 'true',
    );
    expect(
      unrestricted.some((row) => row.tablename === 'scheduled_tasks'),
    ).toBe(true);
    for (const policy of unrestricted) {
      expect(policy, policy.policyname).toMatchObject({
        cmd: 'SELECT',
        roles: ['app_relay'],
      });
    }
  });

  it('no application role bypasses RLS (and all four roles exist)', async () => {
    const { rows } = await client.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolbypassrls FROM pg_roles
      WHERE rolname IN ('app_user', 'app_relay', 'app_owner', 'auth_user')
      ORDER BY rolname
    `);
    expect(rows).toEqual(
      ['app_owner', 'app_relay', 'app_user', 'auth_user'].map((rolname) => ({
        rolname,
        rolbypassrls: false,
      })),
    );
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
    role: 'app_owner',
    public_usage: true,
    public_create: true,
    auth_usage: true,
    auth_create: true,
    db_connect: true,
    db_temp: true,
  },
];

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
    expect(rows).toEqual(EXPECTED_PRIVS);
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
});
