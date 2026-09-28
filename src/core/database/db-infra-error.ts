import { DriverException } from '@mikro-orm/core';
import pg from 'pg';

/**
 * S2-R70 I2: bộ phân loại lỗi HẠ TẦNG của DB (DB không dùng được lúc này, không phải lỗi của request), dùng chung cho
 * `dbErrorMapper` (→ 503) và — sau này — pool `auth_user` của identity (identity → core là chiều phụ thuộc được phép).
 *
 * Hai nhóm:
 * - Server đã trả lời bằng SQLSTATE: lớp 08 (connection exception), 53 (insufficient resources, vd. 53300
 *   too_many_connections), 57P01-57P03 (admin/crash shutdown, cannot connect now), 57014 (statement_timeout/cancel).
 * - Server KHÔNG trả lời (`isDbNoAnswerError`): lỗi socket của Node, và message cố định của pg/pg-pool khi mất kết nối
 *   hoặc hết hạn phía client. Với nhóm này kết quả của câu lệnh đang chạy là KHÔNG BIẾT (vd. COMMIT có thể đã xong).
 *
 * Chỉ nhìn các mắt xích có HÌNH DẠNG lỗi DB (MikroORM `DriverException`, `pg.DatabaseError`, `Error` trần của pg/pg-pool
 * và của `net`): mapper này đăng ký toàn cục, và lỗi của thư viện khác mang cùng mã socket (undici `TypeError: fetch
 * failed` với `cause.code = ECONNREFUSED`) thuộc về mapper của chúng, không phải 503 của DB.
 */
const INFRA_SQLSTATE = /^(?:08|53)[0-9A-Z]{3}$|^57P0[123]$|^57014$/;
const SOCKET_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
];
/** Message cố định (không có `code`) của pg 8.23 / pg-pool 3.14; so khớp chuỗi con vì pg ghép thêm hậu tố. */
const NO_ANSWER_MESSAGES: readonly string[] = [
  // client.js:204: `Connection terminated unexpectedly` (socket đứt) và `Connection terminated` (client bị đóng giữa
  // chừng, vd. bị thu hồi); pg-pool index.js:276 `Connection terminated due to connection timeout`.
  'Connection terminated',
  // client.js:749 `Client has encountered a connection error and is not queryable`, :756 `Client was closed and is not
  // queryable`. Ngoại lệ của "không biết": câu lệnh chưa được gửi (xem `isCommitProvenNotApplied`).
  'is not queryable',
  // client.js:707: `query_timeout` hết hạn.
  'Query read timeout',
  // pg-pool index.js:224: hết `connectionTimeoutMillis` khi chờ slot.
  'timeout exceeded when trying to connect',
];
const MAX_CAUSE_DEPTH = 5;

const isDbShaped = (err: Error): boolean =>
  err instanceof DriverException ||
  err instanceof pg.DatabaseError ||
  Object.getPrototypeOf(err) === Error.prototype ||
  err instanceof AggregateError;

const codeOf = (err: Error): string | undefined =>
  'code' in err && typeof err.code === 'string' ? err.code : undefined;

/** Các mắt xích lỗi dạng DB, theo chuỗi `cause`, dừng ở mắt xích đầu tiên không có hình dạng DB. */
function* dbChain(err: unknown): Generator<Error> {
  for (
    let cur: unknown = err, depth = 0;
    cur instanceof Error && isDbShaped(cur) && depth < MAX_CAUSE_DEPTH;
    cur = cur.cause, depth++
  )
    yield cur;
}

/** Server không trả lời: lỗi socket hoặc message mất kết nối / hạn phía client của pg. Kết quả câu lệnh: không biết. */
export function isDbNoAnswerError(err: unknown): boolean {
  for (const e of dbChain(err)) {
    const code = codeOf(e);
    if (code !== undefined && SOCKET_CODES.includes(code)) return true;
    if (NO_ANSWER_MESSAGES.some((m) => e.message.includes(m))) return true;
  }
  return false;
}

/**
 * Final review I1: lớp SQLSTATE mà câu trả lời cho COMMIT CHỨNG MINH transaction đã rollback. Postgres chạy mọi code của
 * người dùng lúc commit (deferred trigger/constraint → 23, `PreCommit_CheckForSerializationFailure` → 40001) TRƯỚC
 * `RecordTransactionCommit` (xact.c `CommitTransaction`), và lỗi ERROR ở đó abort transaction; 25P03/25P04 là FATAL khi
 * backend còn idle trong transaction, tức COMMIT chưa được xử lý. Lớp 40 là "Transaction Rollback" theo chuẩn SQL.
 *
 * Mọi SQLSTATE khác KHÔNG chứng minh gì lúc COMMIT: 08P01 là lỗi PgBouncer tự dựng ("server conn crashed?", proto.c
 * `send_pooler_error` mặc định 08P01) khi connection server chết lúc COMMIT đang bay, commit có thể đã bền; 57P01 có thể
 * tới SAU khi commit đã ghi cục bộ (syncrep.c `SyncRepWaitForLSN`: "The transaction has already committed locally").
 */
const COMMIT_ROLLBACK_PROVEN_SQLSTATE = /^(?:40|23|25)[0-9A-Z]{3}$/;
/**
 * Review M3: pg ném message này TRƯỚC khi ghi câu lệnh lên socket (client.js:747-758, client đã hỏng hoặc đã đóng, vd. sau
 * khi bị thu hồi), nên COMMIT chưa bao giờ tới server: transaction chưa commit, kết quả BIẾT chắc.
 */
const NEVER_SENT_MESSAGE = 'is not queryable';

/**
 * Lỗi của COMMIT chứng minh transaction KHÔNG được áp dụng: server trả SQLSTATE thuộc lớp 40/23/25, hoặc pg chưa từng gửi
 * COMMIT. Còn lại (mất kết nối, hết hạn phía client, SQLSTATE khác, lỗi không mang dạng DB) → kết quả không biết.
 */
export function isCommitProvenNotApplied(err: unknown): boolean {
  for (const e of dbChain(err)) {
    const code = codeOf(e);
    if (code !== undefined && COMMIT_ROLLBACK_PROVEN_SQLSTATE.test(code))
      return true;
    if (e.message.includes(NEVER_SENT_MESSAGE)) return true;
  }
  return false;
}

/** Lỗi hạ tầng của DB (→ 503): SQLSTATE hạ tầng do server trả, hoặc server không trả lời. */
export function isDbInfraError(err: unknown): boolean {
  for (const e of dbChain(err)) {
    const code = codeOf(e);
    if (code !== undefined && INFRA_SQLSTATE.test(code)) return true;
  }
  return isDbNoAnswerError(err);
}
