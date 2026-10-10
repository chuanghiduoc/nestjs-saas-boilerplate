import pg from 'pg';
import { getInfra } from './infra.js';

const DEFAULT_DEADLINE_MS = 10_000;
const POLL_MS = 20;

export type EntitlementRowHolder = {
  pid: number;
  release(): Promise<void>;
  /** Ghi dưới khoá đang giữ rồi COMMIT (phiên chờ thấy phiên bản dòng mới): ca tất định của C2 (Task 12 Step 4). */
  commitWith(sql: string, params?: unknown[]): Promise<void>;
};

const appClient = (): pg.Client => {
  const { pg: p } = getInfra();
  return new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.app,
  });
};

/**
 * Một kết nối `app_user` riêng mở transaction trong OrgScope của org, chạy `sql` (phải chạm đúng `rows` dòng) và GIỮ
 * transaction: các transaction đang thử xếp hàng sau nó; `release()` (ROLLBACK) thả cho chúng đua.
 */
export async function holdInOrg(
  orgId: string,
  sql: string,
  params: unknown[],
  rows: number,
): Promise<EntitlementRowHolder> {
  const c = appClient();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const r = await c.query(sql, params);
    if (r.rowCount !== rows)
      throw new Error(
        `holder touched ${String(r.rowCount)} rows, expected ${rows}`,
      );
    const { rows: pidRows } = await c.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const pid = pidRows[0]?.pid;
    if (pid === undefined) throw new Error('holder has no backend pid');
    return {
      pid,
      release: async () => {
        try {
          await c.query('ROLLBACK');
        } finally {
          await c.end();
        }
      },
      commitWith: async (q: string, p: unknown[] = []) => {
        try {
          await c.query(q, p);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          await c.end();
        }
      },
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    throw err;
  }
}

/** Barrier của test race gán gói (spec SP4 §17 E-5, E-15): giữ `FOR NO KEY UPDATE` trên dòng `org_entitlements`. */
export const holdEntitlementRow = (
  orgId: string,
): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE',
    [],
    1,
  );

/** Kỳ hiện tại theo `timezone` (cùng `date_trunc` của app) hoặc kỳ NONE (`null`). */
const PERIOD_OF = `CASE WHEN $2::text IS NULL THEN NULL ELSE date_trunc('month', now(), $2::text) END`;

/** Barrier E-1/E-14: giữ khoá dòng bộ đếm (đã seed) như một consume đang mở; consume/release khác xếp hàng sau nó. */
export const holdUsageCounter = (
  orgId: string,
  featureKey: string,
  timezone: string | null,
): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    `SELECT 1 FROM usage_counters u JOIN entitlement_features f ON f.id = u.feature_id
     WHERE u.org_id = app_current_org() AND f.key = $1 AND u.period_start IS NOT DISTINCT FROM ${PERIOD_OF}
     FOR NO KEY UPDATE OF u`,
    [featureKey, timezone],
    1,
  );

/** Barrier E-2: chèn (chưa commit) dòng kỳ hiện tại; consume khác chờ index unique; `release()` = ROLLBACK, dòng chưa từng có. */
export const holdUsageCounterInsert = (
  orgId: string,
  featureKey: string,
  timezone: string | null,
): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, ${PERIOD_OF}, 0, 1 FROM entitlement_features WHERE key = $1`,
    [featureKey, timezone],
    1,
  );

/**
 * Chờ tới khi `count` phiên đang bị `pid` chặn, trực tiếp hoặc bắc cầu (có hạn chót, ledger 3A: không poll vô hạn). Hết
 * hạn → lỗi kèm ảnh chụp `pg_stat_activity` (fail loud, dễ chẩn đoán).
 */
export async function waitForBlocked(
  pid: number,
  count: number,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<void> {
  const c = appClient();
  await c.connect();
  try {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const { rows } = await c.query<{ n: number }>(
        // Bắc cầu: phiên thứ hai trên cùng dòng chờ khoá tuple do phiên thứ nhất (đang chờ `pid`) giữ, nên
        // `pg_blocking_pids` của nó là phiên thứ nhất chứ không phải `pid`.
        `WITH RECURSIVE blocked(pid) AS (
           SELECT a.pid FROM pg_stat_activity a WHERE $1::int = ANY(pg_blocking_pids(a.pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
         )
         SELECT count(*)::int AS n FROM blocked`,
        [pid],
      );
      const n = rows[0]?.n ?? 0;
      if (n >= count) return;
      if (Date.now() > until) {
        const { rows: sessions } = await c.query<{ line: string }>(
          `SELECT pid || ' ' || coalesce(usename, '') || ' ' || coalesce(state, '') || ' ' || coalesce(wait_event_type, '') || ':' ||
                  coalesce(wait_event, '') || ' blockers=' || pg_blocking_pids(pid)::text || ' ' || left(query, 80) AS line
           FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        throw new Error(
          `only ${n} of ${count} sessions queued behind pid ${pid} within ${deadlineMs} ms; sessions:\n${sessions.map((s) => s.line).join('\n')}`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await c.end();
  }
}
