import { ownerQuery } from './identity-app.js';
import { withAppClient } from './tenancy-seed.js';

const POLL_MS = 20;
/** Dưới `idle_in_transaction_session_timeout` của DB test (10 s). */
const DEADLINE_MS = 8_000;

/**
 * Mẫu `raceOnOrgLock` (`org-lock-barrier.ts`) cho một dòng tenant bất kỳ: giữ khoá bằng `lockSql` (vd. `SELECT 1 FROM
 * webhook_endpoints WHERE id = $1 FOR UPDATE`) trong OrgScope trên kết nối riêng, gọi `fire`, chờ tới khi đúng `waiters`
 * backend bị kết nối đó chặn (trực tiếp hoặc bắc cầu qua hàng chờ, `pg_blocking_pids`), rồi COMMIT để thả tất cả cùng lúc.
 * Ép xen kẽ tất định, không dựa vào may rủi của ×N.
 */
export async function raceOnRowLock<T>(
  orgId: string,
  lockSql: string,
  params: unknown[],
  waiters: number,
  fire: () => Promise<T>,
): Promise<T> {
  return withAppClient(async (holder) => {
    await holder.query('BEGIN');
    let pending: Promise<T> | undefined;
    try {
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const locked = await holder.query(lockSql, params);
      if (locked.rowCount !== 1)
        throw new Error(
          `raceOnRowLock: lock query matched ${locked.rowCount} rows`,
        );
      const [{ pid } = { pid: -1 }] = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows;
      pending = fire();
      pending.catch(() => undefined); // lỗi được ném lại khi await bên dưới
      const until = Date.now() + DEADLINE_MS;
      for (;;) {
        const [row] = await ownerQuery<{ n: number }>(
          `WITH RECURSIVE queued(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid)))
           SELECT count(*)::int AS n FROM queued`,
          [pid],
        );
        if ((row?.n ?? 0) >= waiters) break;
        if (Date.now() > until)
          throw new Error(
            `barrier: ${row?.n ?? 0} of ${waiters} transactions queued on the row lock`,
          );
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK');
      throw err;
    }
    return pending;
  });
}
