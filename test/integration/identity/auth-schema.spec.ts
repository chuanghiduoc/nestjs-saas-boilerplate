import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_TABLES } from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { databaseConfig } from '../../../src/core/database/index.js';

describe('auth schema (as auth_user through the auth pool)', () => {
  let pool: pg.Pool;
  let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  it('connects as auth_user with search_path = auth', async () => {
    const { rows } = await pool.query<{ u: string; sp: string }>(
      "SELECT current_user AS u, current_setting('search_path') AS sp",
    );
    expect(rows[0]).toEqual({ u: 'auth_user', sp: 'auth' });
  });
  it('every table of schema auth is in AUTH_TABLES, none has org_id, and ids default to uuidv7()', async () => {
    const t = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(t.rows.map((r) => r.relname)).toEqual([...AUTH_TABLES].sort());
    const org = await owner.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'auth' AND column_name = 'org_id'`,
    );
    expect(org.rows).toEqual([]);
    const ids = await owner.query<{
      table_name: string;
      column_default: string | null;
      data_type: string;
    }>(
      `SELECT table_name, column_default, data_type FROM information_schema.columns WHERE table_schema = 'auth' AND column_name = 'id'`,
    );
    for (const r of ids.rows)
      expect(r, r.table_name).toMatchObject({
        column_default: 'uuidv7()',
        data_type: 'uuid',
      });
  });
  it('auth_user has exactly SELECT/INSERT/UPDATE/DELETE on each auth table', async () => {
    const { rows } = await owner.query<{ table_name: string; privs: string[] }>(
      `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'auth_user' AND table_schema = 'auth' GROUP BY table_name`,
    );
    for (const t of AUTH_TABLES)
      expect(rows.find((r) => r.table_name === t)?.privs, t).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
  });
  it('those grants are explicit per table: no default privilege grants anything to auth_user', async () => {
    // Task 15 carry-forward: a table added later must get its own GRANT in its migration, never inherit one.
    const { rows } = await owner.query<{ grantee: string }>(
      `SELECT pg_get_userbyid(a.grantee) AS grantee FROM pg_default_acl d, aclexplode(d.defaclacl) a
        WHERE a.grantee = 'auth_user'::regrole`,
    );
    expect(rows).toEqual([]);
  });
  it('account (provider_id, account_id) and user email are unique; apikey is owned by its user', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'auth'::regnamespace AND contype IN ('u', 'f')`,
    );
    const defs = rows.map((r) => r.def);
    expect(defs).toContain('UNIQUE (provider_id, account_id)');
    expect(defs).toContain('UNIQUE (email)');
    expect(
      defs.some((d) =>
        /FOREIGN KEY \(reference_id\) REFERENCES auth\."user"\(id\) ON DELETE CASCADE/.test(
          d,
        ),
      ),
    ).toBe(true);
  });
  it('registered_event_emitted_at exists, is nullable and has the partial index used by the reconcile cron', async () => {
    const col = await owner.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'user' AND column_name = 'registered_event_emitted_at'`,
    );
    expect(col.rows[0]).toEqual({ is_nullable: 'YES' });
    const idx = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'user_unmarked_registered_idx'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(
      /\(created_at\) WHERE \(registered_event_emitted_at IS NULL\)/,
    );
  });
});
