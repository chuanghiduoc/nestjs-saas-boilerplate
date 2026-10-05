import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import {
  AUTH_TABLES,
  SESSION_SECOND_FACTOR_TABLE,
} from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

/** Spec SP3 §5.2 hàng migration + `auth-hooks.ts`, §6.12, §6.13 bảng 3D: dấu step-up thuộc hẳn session và factor. */
describe('auth.session_second_factor (spec SP3 §5.2, §9.7 (2))', () => {
  let pool: pg.Pool;
  const user = async () => {
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Mark', $1, true, now(), now(), now()) RETURNING id`,
      [`mark-${randomUUID()}@example.test`],
    );
    const [s] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
      [randomUUID(), u!.id],
    );
    const [f] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('x', 'x', $1, true) RETURNING id`,
      [u!.id],
    );
    return { userId: u!.id, sessionId: s!.id, factorId: f!.id };
  };
  const marks = async (sessionId: string) =>
    (
      await pool.query(
        `SELECT method FROM auth.session_second_factor WHERE session_id = $1`,
        [sessionId],
      )
    ).rows;
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
  });
  afterAll(async () => pool?.end());

  it('is listed in AUTH_TABLES (the schema-auth allowlist of rls-catalog and auth-schema specs)', () => {
    expect(AUTH_TABLES).toContain(SESSION_SECOND_FACTOR_TABLE);
    expect(SESSION_SECOND_FACTOR_TABLE).toBe('session_second_factor');
  });
  it('auth_user writes a mark; method is a closed set; one row per session (upsert target)', async () => {
    const a = await user();
    await pool.query(
      `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`,
      [a.sessionId, a.factorId],
    );
    await expect(
      pool.query(
        `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`,
        [a.sessionId, a.factorId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const b = await user();
    await expect(
      pool.query(
        `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'sms', now())`,
        [b.sessionId, b.factorId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'session_second_factor_method_ck',
    });
  });
  it('deleting the factor or the session removes the mark in the same statement (FK CASCADE, T-35)', async () => {
    const a = await user();
    await pool.query(
      `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'backup_code', now())`,
      [a.sessionId, a.factorId],
    );
    await pool.query(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]);
    expect(await marks(a.sessionId)).toEqual([]);
    const b = await user();
    await pool.query(
      `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`,
      [b.sessionId, b.factorId],
    );
    await pool.query(`DELETE FROM auth.session WHERE id = $1`, [b.sessionId]);
    expect(await marks(b.sessionId)).toEqual([]);
  });
  it('the two_factor_id index serves the CASCADE delete', async () => {
    const rows = await ownerQuery<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'session_second_factor_two_factor_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('(two_factor_id)');
  });
});
