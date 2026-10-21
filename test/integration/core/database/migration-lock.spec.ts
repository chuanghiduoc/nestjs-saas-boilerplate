import { Migration } from '@mikro-orm/migrations';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MIGRATION_ADVISORY_LOCK,
  MIGRATION_LOCK_APPLICATION_NAME,
  MIGRATION_CLIENT_CHECK_INTERVAL_MS,
  MigrationLockLostError,
  runMigrations,
  type MigrationObject,
} from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import {
  createScratchDb,
  type ScratchDb,
} from '../../../support/scratch-db.js';

/**
 * Seam (không sleep may rủi): migration fixture chờ khoá barrier mà test đang giữ, nên migrator thứ nhất đứng yên GIỮA
 * lượt (đã giữ khoá migrator) cho tới khi test nhả barrier. Dạng hai int4, khác key của khoá migrator.
 */
const BARRIER = {
  namespace: MIGRATION_ADVISORY_LOCK.namespace,
  key: 99,
} as const;
/** `idleTimeoutMillis` mặc định của pg-pool (MikroORM 7.2.1 không đặt cho migrator) + lề: CO-2b giữ lượt lâu hơn mức này. */
const POOL_IDLE_TIMEOUT_MS = 10_000;
const IDLE_MARGIN_MS = 2_000;
/** lock_timeout của phiên migration (DB_MIGRATION_LOCK_TIMEOUT_MS mặc định 5000) phải dài hơn lúc fixture chờ barrier. */
const TEST_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
/** Hạn của mọi chờ trạng thái; ≥ 2 × MIGRATION_CLIENT_CHECK_INTERVAL_MS + lề (round-2 C1: backend huỷ câu trong một interval). */
const WAIT_MS = 25_000;
const TABLE = 'mikro_orm_migrations_lock_test';
const OWNER_PASSWORD_ENV = 'DB_OWNER_PASSWORD';

const barrierMigration = (stamp: string): MigrationObject => {
  const migrationName = `Migration${stamp}_lock_barrier`;
  class BarrierMigration extends Migration {
    override name = migrationName;
    override up(): void {
      this.addSql(
        `SELECT pg_advisory_xact_lock(${BARRIER.namespace}, ${BARRIER.key})`,
      );
    }
    override down(): void {
      this.addSql('SELECT 1');
    }
  }
  return { name: migrationName, class: BarrierMigration };
};
class Migration20990101000009_lock_fail extends Migration {
  override name = 'Migration20990101000009_lock_fail';
  override up(): void {
    this.addSql('SELECT 1 / 0');
  }
  override down(): void {
    this.addSql('SELECT 1');
  }
}
const FAIL: MigrationObject = {
  name: 'Migration20990101000009_lock_fail',
  class: Migration20990101000009_lock_fail,
};

describe('migration advisory lock on a dedicated pg.Client (spec SP7 S7-D24, CO-2, CO-2b, R7-12)', () => {
  let scratch: ScratchDb;
  beforeAll(async () => {
    // Env của test (DB_MIGRATION_HOST/PORT, DB_OWNER_*) như `migrations.spec.ts`; DB riêng để khoá không đụng DB chung.
    applyTestEnv();
    scratch = await createScratchDb('migration_lock');
    vi.stubEnv('DB_NAME', scratch.name);
    vi.stubEnv(
      'DB_MIGRATION_LOCK_TIMEOUT_MS',
      String(TEST_MIGRATION_LOCK_TIMEOUT_MS),
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await scratch?.drop();
  });

  const query = async <R extends pg.QueryResultRow>(
    sql: string,
    params: unknown[],
  ) => {
    const c = await scratch.client('owner');
    try {
      return (await c.query<R>(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  /** Khoá (namespace, key) dạng hai int4: `classid`/`objid`, `objsubid = 2`. */
  const advisory = (
    lock: { namespace: number; key: number },
    granted: boolean,
  ) =>
    query<{ pid: number; app: string | null }>(
      `SELECT l.pid, a.application_name AS app FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2 AND l.granted = $3`,
      [lock.namespace, lock.key, granted],
    );
  const sessionsNamed = async (name: string) =>
    (
      await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = $2`,
        [scratch.name, name],
      )
    )[0]?.n;
  /**
   * Review code I1: `client.end()` trả về trước khi backend rời `pg_stat_activity`; đọc một lần ngay sau đó sẽ chập chờn.
   * Poll tới khi đạt giá trị, có hạn; hết hạn thì ném nêu giá trị cuối.
   */
  const eventually = async (
    read: () => Promise<number | undefined>,
    want: number,
  ) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const got = await read();
      if (got === want) return;
      if (Date.now() > deadline)
        throw new Error(
          `expected ${want}, still ${String(got)} after ${WAIT_MS} ms`,
        );
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  const backendsOf = async (pid: number | undefined) =>
    (
      await query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
    )[0]?.n;
  /** Chờ trạng thái quan sát được (không phải chờ thời gian): migrator giữ khoá VÀ migration đang chờ barrier. */
  const waitUntilParkedOnBarrier = async () => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const held = await advisory(MIGRATION_ADVISORY_LOCK, true);
      const waiting = await advisory(BARRIER, false);
      if (held.length === 1 && waiting.length === 1)
        return { holder: held[0], waiter: waiting[0] };
      if (Date.now() > deadline)
        throw new Error('first migrator never parked on the barrier');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  /** Test cầm barrier trên phiên riêng; `release` nhả và đóng phiên ở mọi nhánh. */
  const holdBarrier = async () => {
    const c = await scratch.client('owner');
    await c.query('SELECT pg_advisory_lock($1, $2)', [
      BARRIER.namespace,
      BARRIER.key,
    ]);
    return {
      release: async () => {
        try {
          await c.query('SELECT pg_advisory_unlock($1, $2)', [
            BARRIER.namespace,
            BARRIER.key,
          ]);
        } finally {
          await c.end();
        }
      },
    };
  };

  it('CO-2: a second run while the first holds the lock exits with the named error; lock and session are gone afterwards', async () => {
    const m = barrierMigration('20990101000001');
    const source = { kind: 'list' as const, list: [m] };
    const barrier = await holdBarrier();
    let first: Promise<string[]> | undefined;
    try {
      first = runMigrations('up', { source, tableName: TABLE });
      await waitUntilParkedOnBarrier();
      await expect(
        runMigrations('up', { source, tableName: TABLE }),
      ).rejects.toThrow('Another migration run holds the migration lock');
    } finally {
      await barrier.release();
    }
    await expect(first).resolves.toEqual([m.name]);
    expect(await advisory(MIGRATION_ADVISORY_LOCK, true)).toEqual([]);
    await eventually(() => sessionsNamed(MIGRATION_LOCK_APPLICATION_NAME), 0);
  });

  it('CO-2b: the lock lives on its own named session past the pool idle timeout, is released on that session, and no secret reaches the log', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const m = barrierMigration('20990101000002');
    const source = { kind: 'list' as const, list: [m] };
    const barrier = await holdBarrier();
    let run: Promise<string[]> | undefined;
    try {
      run = runMigrations('up', { source, tableName: TABLE });
      const { holder, waiter } = await waitUntilParkedOnBarrier();
      // Khoá không được nằm trên phiên đang chạy migration (lỗi r0: khoá trên connection mượn của pool ORM).
      expect(holder?.pid).not.toBe(waiter?.pid);
      expect(holder?.app).toBe(MIGRATION_LOCK_APPLICATION_NAME);
      // Thuộc tính cần chứng minh là thời gian: lượt dài hơn idle timeout của pool vẫn giữ khoá trên đúng phiên.
      await new Promise((r) =>
        setTimeout(r, POOL_IDLE_TIMEOUT_MS + IDLE_MARGIN_MS),
      );
      expect((await advisory(MIGRATION_ADVISORY_LOCK, true))[0]?.pid).toBe(
        holder?.pid,
      );
      await expect(
        runMigrations('status', { source, tableName: TABLE }),
      ).rejects.toThrow('Another migration run holds the migration lock');
    } finally {
      await barrier.release();
    }
    try {
      await expect(run).resolves.toEqual([m.name]);
      expect(await advisory(MIGRATION_ADVISORY_LOCK, true)).toEqual([]);
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('"event":"migration_lock_busy"');
      expect(written).not.toContain('migration_lock_release_failed');
      const ownerPassword = process.env[OWNER_PASSWORD_ENV];
      expect(ownerPassword).toBeTruthy();
      expect(written.includes(ownerPassword ?? '')).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it('CO-2c: losing the lock session mid-run aborts the run with a named error, closes the ORM backend and writes nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const m = barrierMigration('20990101000003');
    const source = { kind: 'list' as const, list: [m] };
    const barrier = await holdBarrier();
    let run: Promise<string[]> | undefined;
    try {
      run = runMigrations('up', { source, tableName: TABLE });
      const { holder, waiter } = await waitUntilParkedOnBarrier();
      // Mô phỏng mất phiên khoá (TCP rớt, backend bị giết): khoá nhả ngay, migration phải dừng chứ không chạy tiếp.
      await query('SELECT pg_terminate_backend($1)', [holder?.pid]);
      // Round-2 C1: lượt phải reject khi barrier VẪN đang bị giữ (migration chưa thể xong), trong 2 × interval — không phải
      // sau khi migration chạy tiếp tới COMMIT. Đột biến bỏ vòng `c.end()` cho 'timeout' ở đây (orm.close treo).
      const outcome = await Promise.race([
        run.then(
          () => 'resolved',
          (e: unknown) => e,
        ),
        new Promise((r) =>
          setTimeout(
            () => r('timeout'),
            2 * MIGRATION_CLIENT_CHECK_INTERVAL_MS,
          ),
        ),
      ]);
      expect(outcome).toBeInstanceOf(MigrationLockLostError);
      // Backend của pool ORM (đang chờ barrier) biến mất khi barrier còn giữ: socket đã đóng + client_connection_check_interval.
      await eventually(() => backendsOf(waiter?.pid), 0);
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('"event":"migration_lock_session_lost"');
    } finally {
      stderr.mockRestore();
      await barrier.release();
    }
    // Bảng theo dõi đã có từ CO-2 (cùng TABLE, các ca chạy tuần tự trong file).
    const applied = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE name = $1`,
      [m.name],
    );
    expect(applied[0]?.n).toBe(0);
  });

  it('a failing migration releases the lock and closes the lock session too', async () => {
    await expect(
      runMigrations('up', {
        source: { kind: 'list', list: [FAIL] },
        tableName: TABLE,
      }),
    ).rejects.toThrow(/division by zero/);
    expect(await advisory(MIGRATION_ADVISORY_LOCK, true)).toEqual([]);
    await eventually(() => sessionsNamed(MIGRATION_LOCK_APPLICATION_NAME), 0);
  });
});
