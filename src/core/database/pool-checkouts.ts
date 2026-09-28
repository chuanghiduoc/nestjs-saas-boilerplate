import { Logger } from '@nestjs/common';
import type pg from 'pg';
import { logPoolEvent } from '../logging/index.js';

/**
 * Hai chốt an toàn cho MỌI pool `pg` mà Kysely (MikroORM, Better Auth) dùng, export để pool `auth_user` dùng chung.
 *
 * 1. `watchPoolCheckouts` (S2-R70 I1): kysely 0.29.6 `ControlledTransaction` (MikroORM `transactional`) chỉ trả
 *    connection SAU KHI `COMMIT`/`ROLLBACK` thành công (kysely.js:775-777, :807-809) và không trả khi `BEGIN` lỗi
 *    (:716-717); 0.30.0-beta.2 vẫn vậy. Connection chết giữa transaction (failover, PgBouncer restart,
 *    `pg_terminate_backend`, `idle_in_transaction_session_timeout`) làm ROLLBACK lỗi ngay, nên slot pool mất vĩnh viễn:
 *    sau `max` lần như vậy mọi query chờ mãi. Sửa ở phía mình, không vá dependency: client ĐANG ĐƯỢC MƯỢN mà phát
 *    `'end'`/`'error'` (connection đã chết) được trả về pool kèm lỗi thay cho người mượn (pg-pool bỏ client, giải phóng
 *    slot, index.js:392), và `release` của người mượn thành no-op để lần trả muộn (nếu có) không ném "Release called on
 *    client which has already been released". Tuỳ chọn: hạn giữ một checkout (`holdDeadlineMs`, bộ thu hồi của api) và
 *    `releaseAll` (tắt máy).
 * 2. `clientDestroyReason` (S2-R60/S2-R67, review M1-M3): client được trả KHÔNG kèm lỗi chỉ về pool khi nó dùng lại được.
 *
 * S2-R73: mọi log của listener trong file này đi qua `logPoolEvent` (không gọi `Logger#warn` trực tiếp) — các listener
 * này chạy trong continuation async của request đã TẠO/MƯỢN connection trước đó, không phải request đang gây ra sự
 * kiện, nên dòng log không được mang requestId/url của bất kỳ request nào (xem `core/logging/pool-log.ts`).
 */

/** Vì sao một client được trả về bị huỷ thay vì về pool (`undefined` = về pool). */
export type DestroyReason = 'not_ready_for_query' | 'open_transaction';

/**
 * - `readyForQuery === true` và `getTransactionStatus() === 'I'`: về pool.
 * - `readyForQuery === true`, trạng thái khác `'I'` (review M3): trả giữa transaction (`T`) hoặc transaction hỏng
 *   (`E`) → `open_transaction`, người mượn sau sẽ nhận 25P02 hoặc thừa hưởng lock.
 * - `readyForQuery !== true` nhưng KHÔNG còn query nào đang chạy hay xếp hàng (`_activeQuery` null, hàng đợi rỗng):
 *   query vừa lỗi phía server. Postgres flush ErrorResponse riêng, pg reject promise ngay tại ErrorResponse và đặt
 *   `_activeQuery = null` (client.js:437) nhưng `readyForQuery` chỉ thành `true` khi ReadyForQuery tới; Kysely trả client
 *   trong khoảng đó (review S2-R67 M1: ~5-6% lỗi SQL ngoài transaction qua PgBouncer). Client vẫn lành: query sau được pg
 *   xếp hàng tới ReadyForQuery. Giữ lại, với điều kiện trạng thái transaction cuối cùng biết được là `'I'`.
 * - Còn lại → `not_ready_for_query`: query còn đang chạy (hết `query_timeout` mà server không trả lời: pg không huỷ client,
 *   client.js:706-731) — giữ lại thì query sau xếp hàng sau query không bao giờ xong.
 *
 * Các trường `readyForQuery`/`_activeQuery`/`_queryQueue` không nằm trong type của pg: đọc fail-closed (vắng mặt = coi như
 * còn query đang chạy → huỷ; cái giá xấu nhất là mở connection mới).
 */
export function clientDestroyReason(
  client: pg.PoolClient,
): DestroyReason | undefined {
  const ready = 'readyForQuery' in client ? client.readyForQuery : undefined;
  const idleInTx = client.getTransactionStatus() === 'I';
  if (ready === true) return idleInTx ? undefined : 'open_transaction';
  const active = '_activeQuery' in client ? client._activeQuery : 'unknown';
  const queue = '_queryQueue' in client ? client._queryQueue : undefined;
  const awaitingReadyAfterError =
    active == null && Array.isArray(queue) && queue.length === 0;
  return awaitingReadyAfterError && idleInTx
    ? undefined
    : 'not_ready_for_query';
}

/**
 * Listener 'release': huỷ client không dùng lại được (`clientDestroyReason`). Trả kèm lỗi thì CHÍNH pg-pool bỏ và `end()`
 * client (index.js:392 → `_remove`): không end lần hai, không log (review S2-R60 M1). pg-pool phát 'release' ĐỒNG BỘ trước
 * khi quyết định giữ hay bỏ (index.js:389, rồi :392 bỏ khi `client._ending`); `client.end()` đặt `_ending` đồng bộ và huỷ
 * socket ngay khi còn query đang chạy (client.js:782,804-806).
 */
export function destroyUnusableClients(pool: pg.Pool, label: string): void {
  const logger = new Logger(`DbPool:${label}`);
  pool.on('release', (err, client) => {
    if (err) return;
    const reason = clientDestroyReason(client);
    if (reason === undefined) return;
    logPoolEvent(
      logger,
      { event: 'db_pool_client_destroyed', pool: label, reason },
      'pool client released in a state it cannot be reused from; destroying it',
    );
    // `end()` không bao giờ reject (resolve ở 'end' của connection); `_remove` của pg-pool gọi lại `end(cb)` an toàn.
    void client.end();
  });
}

/**
 * Final review M2: client RẢNH của pool core bị đứt (PgBouncer restart, `pg_terminate_backend`, failover) làm pg-pool phát
 * 'error' trên pool. Listener của MikroORM (`PostgreSqlConnection.handlePoolErrors`) giữ process không sập nhưng chỉ log khi
 * `DB_DEBUG` bật (`DefaultLogger.isEnabled`), mà production cấm `DB_DEBUG`: sự cố của `core_app`/`core_relay` im lặng trong
 * khi pool auth có `auth_pool_idle_error`. Log ở đây, cùng mẫu với pool auth: chỉ trường pool-scoped (tên pool, SQLSTATE
 * hoặc mã socket, lớp lỗi), không message (có thể chứa host/user). pg-pool đã tự bỏ client hỏng; không ném lại.
 */
export function logIdleClientErrors(pool: pg.Pool, label: string): void {
  const logger = new Logger(`DbPool:${label}`);
  pool.on('error', (err: Error & { code?: unknown }) =>
    logPoolEvent(
      logger,
      {
        event: 'db_pool_idle_error',
        pool: label,
        code: typeof err.code === 'string' ? err.code : undefined,
        name: err.name,
      },
      'idle pool connection failed; dropped from the pool',
    ),
  );
}

export type PoolCheckoutsOptions = {
  /** Tên pool trong log (`core_app`, `core_relay`, `auth`). */
  label: string;
  /** Có: checkout giữ lâu hơn mức này bị thu hồi (bộ thu hồi của api, `HTTP_REQUEST_BUDGET_MS`). */
  holdDeadlineMs?: number;
};

/** Theo dõi các client đang được mượn của một pool; xem chú thích đầu file. */
export class PoolCheckouts {
  private readonly held = new Map<pg.PoolClient, () => void>();
  private readonly logger: Logger;

  constructor(
    pool: pg.Pool,
    private readonly opts: PoolCheckoutsOptions,
  ) {
    this.logger = new Logger(`DbPool:${opts.label}`);
    pool.on('acquire', (client) => this.onAcquire(client));
    // Dọn listener/timer trước mọi listener 'release' khác đăng ký sau (vd. `destroyUnusableClients` gọi `end()`).
    pool.on('release', (_err, client) => this.onRelease(client));
  }

  /** Số client đang được mượn (cho test và log tắt máy). */
  get size(): number {
    return this.held.size;
  }

  /** Trả MỌI checkout còn giữ về pool kèm lỗi (tắt máy: sau khi drain, ai còn giữ connection là đã bỏ rơi nó). */
  releaseAll(reason: string): number {
    const clients = [...this.held.keys()];
    for (const client of clients) this.forceRelease(client, new Error(reason));
    return clients.length;
  }

  private onAcquire(client: pg.PoolClient): void {
    const onError = (err: Error): void => {
      logPoolEvent(
        this.logger,
        { event: 'db_pool_checkout_connection_lost', pool: this.opts.label },
        'connection of a checked-out pool client died; returning its slot to the pool',
      );
      this.forceRelease(client, err);
    };
    const onEnd = (): void =>
      onError(new Error('Connection terminated unexpectedly'));
    client.once('error', onError);
    client.once('end', onEnd);
    const deadlineMs = this.opts.holdDeadlineMs;
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
            logPoolEvent(
              this.logger,
              {
                event: 'db_pool_checkout_reaped',
                pool: this.opts.label,
                deadlineMs,
              },
              'pool connection held past its deadline; destroying it and returning its slot',
            );
            this.forceRelease(
              client,
              new Error(`checkout held longer than ${deadlineMs} ms`),
            );
          }, deadlineMs);
    // Không giữ process sống chỉ vì timer này.
    timer?.unref();
    this.held.set(client, () => {
      client.off('error', onError);
      client.off('end', onEnd);
      clearTimeout(timer);
    });
  }

  private onRelease(client: pg.PoolClient): void {
    this.held.get(client)?.();
    this.held.delete(client);
  }

  /**
   * Trả client về pool kèm lỗi thay cho người mượn: pg-pool bỏ và `end()` client, slot được giải phóng. Query còn chạy
   * nhận `Connection terminated`, query sau nhận `Client was closed and is not queryable` (đều → 503). `release` của người
   * mượn thành no-op: Kysely và `pool.query` đọc `client.release` lúc gọi.
   */
  private forceRelease(client: pg.PoolClient, err: Error): void {
    if (!this.held.has(client)) return;
    client.release(err);
    client.release = () => undefined;
  }
}

export function watchPoolCheckouts(
  pool: pg.Pool,
  opts: PoolCheckoutsOptions,
): PoolCheckouts {
  return new PoolCheckouts(pool, opts);
}
