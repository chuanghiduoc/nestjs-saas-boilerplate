import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

const POLL_MS = 20;
const WAIT_DEADLINE_MS = 4_000;
type Shape = { constraints: string[]; columns: string[] };

/**
 * Spec SP3 §6.13 bảng 3D (r7 R7-C1, r8 R8-C3): `down` của `…_security_notice_operator_reset` lấy `ACCESS EXCLUSIVE` TRƯỚC
 * mọi đọc, từ chối khi còn marker `operator_reset` chưa ở trạng thái cuối HOẶC thư của chúng còn `PENDING`/`SENDING`, rồi
 * mới xoá marker và trả schema về đúng bản chụp TRƯỚC `up` (không so với assert của `auth-schema.spec.ts`, vì 3D sửa nó).
 */
describe('down of …_security_notice_operator_reset', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let before: Shape;
  let owner: pg.Client;
  let userId: string;
  const shape = async (): Promise<Shape> => ({
    constraints: (
      await owner.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'auth.security_notice'::regclass`,
      )
    ).rows
      .map((r) => r.def)
      .sort(),
    columns: (
      await owner.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'security_notice'`,
      )
    ).rows
      .map((r) => r.c)
      .sort(),
  });
  const down = () =>
    runMigrations('down', {
      source: { kind: 'list', list },
      to: previous,
    });
  const marker = async (o: { notified?: boolean; abandoned?: boolean } = {}) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO auth.security_notice (user_id, kind, ticket, notified_at, abandoned_at)
       VALUES ($1, 'operator_reset', 'T-1', CASE WHEN $2 THEN clock_timestamp() END, CASE WHEN $3 THEN clock_timestamp() END) RETURNING id`,
        [userId, o.notified ?? false, o.abandoned ?? false],
      )
    ).rows[0]!.id;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('opreset');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) =>
      m.name.endsWith('_security_notice_operator_reset'),
    );
    if (at < 1)
      throw new Error('security_notice_operator_reset migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', {
      source: { kind: 'list', list: list.slice(0, at) },
    });
    owner = await db.client('owner');
    before = await shape();
    await runMigrations('up', { source: { kind: 'list', list } });
    userId = (
      await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Op', $1, true, now(), now(), now()) RETURNING id`,
        [`op-${v7()}@example.test`],
      )
    ).rows[0]!.id;
    // Một marker `two_factor_*` đã gửi: phải còn nguyên sau down.
    await owner.query(
      `INSERT INTO auth.security_notice (user_id, kind, notified_at) VALUES ($1, 'two_factor_disabled', clock_timestamp())`,
      [userId],
    );
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) a pending operator_reset marker → RAISE, schema and rows unchanged', async () => {
    const id = await marker();
    await expect(down()).rejects.toThrow(
      /operator_reset markers or mails are not finished/,
    );
    expect(
      (
        await owner.query(`SELECT 1 FROM auth.security_notice WHERE id = $1`, [
          id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect((await shape()).columns).toContain('ticket');
    await owner.query(
      `UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at) WHERE id = $1`,
      [id],
    );
  });
  it('(b) a notified marker whose mail is still PENDING → RAISE', async () => {
    const [{ id } = { id: '' }] = (
      await owner.query<{ id: string }>(
        `SELECT id FROM auth.security_notice WHERE kind = 'operator_reset' AND notified_at IS NOT NULL`,
      )
    ).rows;
    const pid = v7();
    await owner.query(
      `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
       VALUES ($1, 'two-factor-changed', 'en', 'x', 'y', 'PENDING', $2)`,
      [pid, `two-factor-changed:${userId}:${id}`],
    );
    await expect(down()).rejects.toThrow(
      /operator_reset markers or mails are not finished/,
    );
    await owner.query(
      `UPDATE email_deliveries SET state = 'SENT', params_enc = NULL, attempts = 1, completed_at = now() WHERE public_id = $1`,
      [pid],
    );
  });
  it('(d) atomic: a marker inserted by an open transaction before the down acquires its lock makes the down RAISE once committed', async () => {
    const b = await db.client('auth');
    try {
      await b.query('BEGIN');
      await b.query(
        `INSERT INTO auth.security_notice (user_id, kind, ticket) VALUES ($1, 'operator_reset', 'T-2')`,
        [userId],
      );
      const pending = down();
      pending.catch(() => undefined);
      const until = Date.now() + WAIT_DEADLINE_MS;
      // Tiến trình của down đang chờ khoá trên auth.security_notice (không ngủ cố định).
      for (;;) {
        const { rows } = await owner.query(
          `SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'security_notice' AND NOT l.granted AND l.mode = 'AccessExclusiveLock'`,
        );
        if (rows.length > 0) break;
        if (Date.now() > until)
          throw new Error('down never queued on auth.security_notice');
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await b.query('COMMIT');
      await expect(pending).rejects.toThrow(
        /operator_reset markers or mails are not finished/,
      );
      expect(
        (
          await owner.query(
            `SELECT 1 FROM auth.security_notice WHERE ticket = 'T-2'`,
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await b.end();
    }
    await owner.query(
      `UPDATE auth.security_notice SET abandoned_at = GREATEST(clock_timestamp(), created_at) WHERE ticket = 'T-2'`,
    );
  });
  it('(c) every marker terminal and every mail SENT → down passes: operator_reset markers deleted, two_factor_* kept, schema equals the snapshot before up', async () => {
    await marker({ abandoned: true });
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(
      (
        await owner.query(
          `SELECT kind FROM auth.security_notice WHERE user_id = $1`,
          [userId],
        )
      ).rows,
    ).toEqual([{ kind: 'two_factor_disabled' }]);
    expect(await shape()).toEqual(before);
  });
});
