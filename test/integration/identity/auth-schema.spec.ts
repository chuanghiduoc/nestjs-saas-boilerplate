import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_TABLES,
  SECURITY_NOTICE_TABLE,
  USER_RECLAIM_TABLE,
} from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { databaseConfig } from '../../../src/core/database/index.js';

/** SQLSTATE của lỗi Postgres, hoặc `undefined` nếu câu lệnh chạy được. */
async function sqlState(
  c: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT probe');
    return undefined;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    if (err instanceof pg.DatabaseError) return err.code;
    throw err;
  }
}

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
  it('auth_user has exactly SELECT/INSERT/UPDATE/DELETE on each library-shaped auth table', async () => {
    const { rows } = await owner.query<{ table_name: string; privs: string[] }>(
      `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'auth_user' AND table_schema = 'auth' GROUP BY table_name`,
    );
    for (const t of AUTH_TABLES.filter(
      (n) => n !== USER_RECLAIM_TABLE && n !== SECURITY_NOTICE_TABLE,
    ))
      expect(rows.find((r) => r.table_name === t)?.privs, t).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
  });
  it('S2-R76: user_reclaim grants auth_user exactly SELECT, INSERT and UPDATE(reclaimed_at), no DELETE', async () => {
    const table = await owner.query<{ privs: string[] }>(
      `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'auth_user' AND table_schema = 'auth' AND table_name = $1`,
      [USER_RECLAIM_TABLE],
    );
    expect(table.rows[0]?.privs).toEqual(['INSERT', 'SELECT']);
    const cols = await owner.query<{ col: string }>(
      `SELECT column_name AS col FROM information_schema.column_privileges
        WHERE grantee = 'auth_user' AND table_schema = 'auth' AND table_name = $1 AND privilege_type = 'UPDATE'`,
      [USER_RECLAIM_TABLE],
    );
    expect(cols.rows.map((r) => r.col)).toEqual(['reclaimed_at']);
  });
  it('S2-R75: security_notice grants auth_user exactly SELECT, INSERT, DELETE and UPDATE(notified_at)', async () => {
    const table = await owner.query<{ privs: string[] }>(
      `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'auth_user' AND table_schema = 'auth' AND table_name = $1`,
      [SECURITY_NOTICE_TABLE],
    );
    expect(table.rows[0]?.privs).toEqual(['DELETE', 'INSERT', 'SELECT']);
    const cols = await owner.query<{ col: string }>(
      `SELECT column_name AS col FROM information_schema.column_privileges
        WHERE grantee = 'auth_user' AND table_schema = 'auth' AND table_name = $1 AND privilege_type = 'UPDATE'`,
      [SECURITY_NOTICE_TABLE],
    );
    expect(cols.rows.map((r) => r.col)).toEqual(['notified_at']);
    // Hàm trigger không cấp EXECUTE cho ai (không gọi trực tiếp được; trigger chạy không cần EXECUTE).
    const fn = await owner.query<{ acl: string | null }>(
      `SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'auth.record_two_factor_notice()'::regprocedure`,
    );
    expect(fn.rows[0]?.acl).not.toMatch(/(^|[{,])=X/);
    expect(fn.rows[0]?.acl ?? '').not.toContain('auth_user=');
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

  /** Chạy `fn` trong một transaction của auth_user rồi luôn ROLLBACK: test không để lại dòng nào. */
  async function inRolledBackTx(
    fn: (c: pg.PoolClient, userId: string) => Promise<void>,
  ): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO "user" (name, email, email_verified) VALUES ('T', $1, false) RETURNING id::text AS id`,
        [`t26-${Date.now()}-${Math.random()}@example.test`],
      );
      await fn(c, rows[0]!.id);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('S2-R76: user_reclaim is keyed by its user (FK cascade), NOT NULL timestamps, reclaimed_at >= created_at; the marker follows a deleted user', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'auth.user_reclaim'::regclass ORDER BY 1`,
    );
    expect(rows.map((r) => r.def)).toEqual([
      'CHECK ((reclaimed_at >= created_at))',
      'FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE',
      // Postgres 18 catalogs NOT NULL as constraints too.
      'NOT NULL created_at',
      'NOT NULL reclaimed_at',
      'NOT NULL user_id',
      'PRIMARY KEY (user_id)',
    ]);
    const nullable = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = $1 AND is_nullable = 'YES'`,
      [USER_RECLAIM_TABLE],
    );
    expect(nullable.rows).toEqual([]);
    await inRolledBackTx(async (c, userId) => {
      const upsert = `INSERT INTO user_reclaim (user_id, reclaimed_at) VALUES ($1, now())
        ON CONFLICT (user_id) DO UPDATE SET reclaimed_at = EXCLUDED.reclaimed_at`;
      expect(await sqlState(c, upsert, [userId])).toBeUndefined();
      expect(await sqlState(c, upsert, [userId])).toBeUndefined();
      expect(
        await sqlState(
          c,
          `UPDATE user_reclaim SET reclaimed_at = created_at - interval '1 second' WHERE user_id = $1`,
          [userId],
        ),
      ).toBe('23514');
      expect(
        await sqlState(c, `DELETE FROM user_reclaim WHERE user_id = $1`, [
          userId,
        ]),
      ).toBe('42501');
      expect(
        await sqlState(
          c,
          `UPDATE user_reclaim SET created_at = now() WHERE user_id = $1`,
          [userId],
        ),
      ).toBe('42501');
      // auth_user xoá user (admin remove-user): cascade chạy với quyền chủ bảng, không cần DELETE trên user_reclaim.
      expect(
        await sqlState(c, `DELETE FROM "user" WHERE id = $1`, [userId]),
      ).toBeUndefined();
      const left = await c.query(
        `SELECT 1 FROM user_reclaim WHERE user_id = $1`,
        [userId],
      );
      expect(left.rows).toEqual([]);
    });
  });

  it('S2-R75: security_notice belongs to its user (FK cascade), kind is a closed CHECK, timestamps NOT NULL except notified_at >= created_at; the trigger fires only on a real 2FA flip; indexes serve the cron, the fast path and the purge', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'auth.security_notice'::regclass ORDER BY 1`,
    );
    expect(rows.map((r) => r.def)).toEqual([
      "CHECK ((kind = ANY (ARRAY['two_factor_enabled'::text, 'two_factor_disabled'::text])))",
      'CHECK ((notified_at >= created_at))',
      'FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE',
      'NOT NULL created_at',
      'NOT NULL id',
      'NOT NULL kind',
      'NOT NULL user_id',
      'PRIMARY KEY (id)',
    ]);
    const idx = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND tablename = $1 ORDER BY indexname`,
      [SECURITY_NOTICE_TABLE],
    );
    expect(idx.rows.map((r) => r.indexdef.replace(/^.* USING /, ''))).toEqual([
      'btree (notified_at)',
      'btree (created_at) WHERE (notified_at IS NULL)',
      'btree (id)',
      'btree (user_id)',
    ]);
    const trg = await owner.query<{ def: string }>(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'auth."user"'::regclass AND NOT tgisinternal`,
    );
    expect(trg.rows.map((r) => r.def)).toEqual([
      'CREATE TRIGGER user_two_factor_notice_trg AFTER UPDATE OF two_factor_enabled ON auth."user" FOR EACH ROW WHEN ((old.two_factor_enabled IS DISTINCT FROM new.two_factor_enabled)) EXECUTE FUNCTION auth.record_two_factor_notice()',
    ]);
    await inRolledBackTx(async (c, userId) => {
      // Trigger chạy với quyền auth_user (câu UPDATE của Better Auth).
      await c.query(
        `UPDATE "user" SET two_factor_enabled = true WHERE id = $1`,
        [userId],
      );
      const {
        rows: [n],
      } = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM security_notice WHERE user_id = $1`,
        [userId],
      );
      expect(n).toBeDefined();
      expect(
        await sqlState(
          c,
          `INSERT INTO security_notice (user_id, kind) VALUES ($1, 'password_changed')`,
          [userId],
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          c,
          `UPDATE security_notice SET notified_at = created_at - interval '1 second' WHERE id = $1`,
          [n!.id],
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          c,
          `UPDATE security_notice SET kind = 'two_factor_disabled' WHERE id = $1`,
          [n!.id],
        ),
      ).toBe('42501');
      expect(await sqlState(c, `SELECT auth.record_two_factor_notice()`)).toBe(
        '42501',
      );
      expect(
        await sqlState(
          c,
          `UPDATE security_notice SET notified_at = now() WHERE id = $1`,
          [n!.id],
        ),
      ).toBeUndefined();
      expect(
        await sqlState(c, `DELETE FROM "user" WHERE id = $1`, [userId]),
      ).toBeUndefined();
      const left = await c.query(
        `SELECT 1 FROM security_notice WHERE user_id = $1`,
        [userId],
      );
      expect(left.rows).toEqual([]);
    });
  });

  it('two_factor has one row per user: a second row for the same user_id violates UNIQUE (review I1)', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'auth.two_factor'::regclass AND contype = 'u'`,
    );
    expect(rows.map((r) => r.def)).toEqual(['UNIQUE (user_id)']);
    await inRolledBackTx(async (c, userId) => {
      const insert = `INSERT INTO two_factor (secret, backup_codes, user_id) VALUES ('s', 'b', $1)`;
      expect(await sqlState(c, insert, [userId])).toBeUndefined();
      expect(await sqlState(c, insert, [userId])).toBe('23505');
    });
  });

  it('security flags are NOT NULL with the Better Auth 1.7.6 defaults, never fail-open (review I2, S2-R26)', async () => {
    const { rows } = await owner.query<{
      col: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name || '.' || column_name AS col, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'auth' AND (table_name, column_name) IN
          (('user', 'two_factor_enabled'), ('user', 'banned'), ('two_factor', 'verified'),
           ('two_factor', 'failed_verification_count'), ('apikey', 'enabled'))
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { col: 'apikey.enabled', is_nullable: 'NO', column_default: 'true' },
      {
        col: 'two_factor.failed_verification_count',
        is_nullable: 'NO',
        column_default: '0',
      },
      { col: 'two_factor.verified', is_nullable: 'NO', column_default: 'true' },
      { col: 'user.banned', is_nullable: 'NO', column_default: 'false' },
      {
        col: 'user.two_factor_enabled',
        is_nullable: 'NO',
        column_default: 'false',
      },
    ]);
    await inRolledBackTx(async (c, userId) => {
      const flags = await c.query(
        'SELECT two_factor_enabled, banned FROM "user" WHERE id = $1',
        [userId],
      );
      expect(flags.rows[0]).toEqual({
        two_factor_enabled: false,
        banned: false,
      });
      const tf = await c.query(
        `INSERT INTO two_factor (secret, backup_codes, user_id) VALUES ('s', 'b', $1)
          RETURNING verified, failed_verification_count`,
        [userId],
      );
      expect(tf.rows[0]).toEqual({
        verified: true,
        failed_verification_count: 0,
      });
      const key = await c.query(
        `INSERT INTO apikey (config_id, reference_id, key, created_at, updated_at)
          VALUES ('default', $1, 'hash', now(), now()) RETURNING enabled`,
        [userId],
      );
      expect(key.rows[0]).toEqual({ enabled: true });
      // Ghi NULL tường minh hoặc bộ đếm âm (repair SQL, restore) bị DB từ chối thay vì âm thầm tắt khoá.
      for (const sql of [
        'UPDATE "user" SET two_factor_enabled = NULL WHERE id = $1',
        'UPDATE "user" SET banned = NULL WHERE id = $1',
        'UPDATE two_factor SET verified = NULL WHERE user_id = $1',
        'UPDATE two_factor SET failed_verification_count = NULL WHERE user_id = $1',
        'UPDATE apikey SET enabled = NULL WHERE reference_id = $1',
      ])
        expect(await sqlState(c, sql, [userId]), sql).toBe('23502');
      expect(
        await sqlState(
          c,
          'UPDATE two_factor SET failed_verification_count = -1 WHERE user_id = $1',
          [userId],
        ),
      ).toBe('23514');
    });
  });

  it('has exactly the indexes backed by a query (review M1: no secret/config_id index)', async () => {
    const { rows } = await owner.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'auth' AND indexname LIKE '%\\_idx' ORDER BY 1`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'account_user_id_idx',
      'apikey_key_idx',
      'apikey_reference_id_idx',
      'login_attempts_expire_idx',
      'rate_limit_last_request_idx',
      // S2-R75: purge, cron/gauge, FK cascade + đường gửi nhanh.
      'security_notice_notified_at_idx',
      'security_notice_pending_idx',
      'security_notice_user_id_idx',
      'session_expires_at_idx',
      'session_user_id_idx',
      'user_unmarked_registered_idx',
      'verification_expires_at_idx',
      'verification_identifier_idx',
    ]);
  });
});
