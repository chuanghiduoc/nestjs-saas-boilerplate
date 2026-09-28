import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { normalizeEmail } from '../../../src/modules/identity/infra/better-auth/email-normalize.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

/**
 * Final review M4: `auth."user".email` chỉ nhận dạng chuẩn (`user_email_canonical_ck`), để UNIQUE so từng byte của nó
 * cũng là UNIQUE theo `normalizeEmail`. Mọi kết quả của `normalizeEmail` phải qua được CHECK (ràng buộc không bao giờ
 * từ chối ghi hợp lệ của app), còn biến thể chưa chuẩn (hoa, dấu cách thừa, Unicode chưa NFC) bị DB từ chối.
 */
/** Dấu kết hợp viết bằng code point: ký tự vô hình trong mã nguồn dễ bị editor/formatter đổi dạng. */
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const COMBINING_DIAERESIS = String.fromCodePoint(0x308);

describe('auth."user".email canonical form (final review M4)', () => {
  let pool: pg.Pool;
  let owner: pg.Client;

  /** SQLSTATE khi `auth_user` chèn user với `email` trong một transaction luôn ROLLBACK, hoặc `undefined` nếu chèn được. */
  const insertState = async (email: string): Promise<string | undefined> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO "user" (name, email, email_verified) VALUES ('T', $1, false)`,
        [email],
      );
      return undefined;
    } catch (err) {
      if (err instanceof pg.DatabaseError) return err.code;
      throw err;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  };
  const unique = (local: string) =>
    `${local}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.test`;

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

  it('the constraint exists, and the database encoding is UTF8 (required by IS NFC NORMALIZED)', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'auth."user"'::regclass AND conname = 'user_email_canonical_ck'`,
    );
    expect(rows).toEqual([
      {
        def: 'CHECK (((email = lower(btrim(email))) AND (email IS NFC NORMALIZED)))',
      },
    ]);
    const enc = await owner.query<{ enc: string }>(
      'SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()',
    );
    expect(enc.rows[0]?.enc).toBe('UTF8');
  });

  it.each([
    ['upper case', (e: string) => e.toUpperCase()],
    ['leading space', (e: string) => ` ${e}`],
    ['trailing space', (e: string) => `${e} `],
    ['upper-case non-ASCII', (e: string) => `É${e}`],
    ['decomposed (NFD) accent', (e: string) => `e${COMBINING_ACUTE}${e}`],
  ])(
    'rejects a non-canonical email (%s) with 23514',
    async (_name, variant) => {
      expect(await insertState(variant(unique('user')))).toBe('23514');
    },
  );

  it.each([
    ['ASCII with case and whitespace', ' \tUser.Name+tag '],
    ['precomposed upper-case accent', 'ÉLISE'],
    ['decomposed accent', `E${COMBINING_ACUTE}lise`],
    ['titlecase digraph', 'ǅemo'],
    ['dotted capital I', 'İstanbul'],
    ['final sigma', 'ΣΟΦΙΑΣ'],
    ['capital sharp s', 'ẞTRASSE'],
    [
      'T with combining diaeresis (NFC after lower-casing)',
      `T${COMBINING_DIAERESIS}om`,
    ],
  ])(
    'accepts every normalizeEmail result (%s): the CHECK never rejects a write of the app',
    async (_name, local) => {
      const email = normalizeEmail(unique(local));
      expect(await insertState(email)).toBeUndefined();
    },
  );
});
