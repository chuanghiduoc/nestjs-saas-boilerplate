import { ownerQuery } from './identity-app.js';
import { withAppClient } from './tenancy-seed.js';

const POLL_MS = 20;
/** Dưới `idle_in_transaction_session_timeout` của DB test (10 s): quá hạn thì lỗi là của barrier, không phải 25P03. */
const DEADLINE_MS = 8_000;

/**
 * Spec SP3 §18.0 (INT2-N-5): mutation quản trị xếp hàng ở bước khoá org (§8.6 bước 1). Test giữ khoá dòng org trên kết
 * nối riêng; chờ tới khi đúng `waiters` backend bị kết nối đó chặn, trực tiếp hoặc bắc cầu qua hàng chờ (lọc bằng
 * `pg_blocking_pids`, không đếm khoá của test khác), rồi COMMIT để thả tất cả cùng lúc. Quá hạn chót → ném, không treo.
 */
export async function raceOnOrgLock<T>(
  orgId: string,
  waiters: number,
  fire: () => Promise<T>,
): Promise<T> {
  return withAppClient(async (holder) => {
    await holder.query('BEGIN');
    let pending: Promise<T> | undefined;
    try {
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      await holder.query(
        'SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
        [orgId],
      );
      const [{ pid } = { pid: -1 }] = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows;
      pending = fire();
      pending.catch(() => undefined); // lỗi được ném lại khi await bên dưới; tránh unhandled rejection trong lúc chờ
      const until = Date.now() + DEADLINE_MS;
      for (;;) {
        // Bắc cầu: Postgres xếp hàng người chờ khoá dòng, nên người chờ thứ hai bị người thứ nhất chặn (`pg_blocking_pids`
        // trả người đứng trước trong hàng), không phải kết nối giữ khoá.
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
            `barrier: ${row?.n ?? 0} of ${waiters} transactions queued on the org lock`,
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
