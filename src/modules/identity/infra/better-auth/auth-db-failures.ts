import { AsyncLocalStorage } from 'node:async_hooks';
import { isAPIError } from 'better-auth/api';
import type { LogEvent, PostgresPool } from 'kysely';
import pg from 'pg';
import { safeErrorFields } from '../../identity-telemetry.js';
import { isAuthInfraError, isPgClientInfraError } from './auth-error.mapper.js';

export type AuthDbFailure = ReturnType<typeof safeErrorFields>;
type Scope = {
  /** Lỗi HẠ TẦNG đầu tiên của pool `auth_user` (57014, 08*, 53*, 57P0*, deadline, mất connection, hết chờ pool). */
  failure?: AuthDbFailure;
  /** Lỗi DB đầu tiên bất kỳ của pool `auth_user` (kể cả 42501): chỉ để dòng log fail-loud mang SQLSTATE (review M7). */
  dbError?: AuthDbFailure;
  /** Lỗi không phải `APIError` và không đến từ pool auth (TypeError, Redis, DB app) mà `onApiError` thấy (review M1). */
  unexplained?: AuthDbFailure;
  /** Path Better Auth (đã bỏ `basePath`) của request mà mount đang phục vụ (spec SP3 T8). */
  path?: string;
};

/**
 * S2-R65: Better Auth NUỐT lỗi gốc của storage (`getSession` → `APIError(500, FAILED_TO_GET_SESSION)` không `cause`,
 * `getSessionFromCtx` → `null` rồi 401, `verifyApiKey` → `INVALID_API_KEY`), nên một query bị huỷ khi DB vẫn khoẻ qua được
 * probe S2-R45 và thành 500 (hoặc 401). Lỗi của pool `auth_user` được ghi vào một scope theo TỪNG lời gọi vào Better
 * Auth (một request của mount, một lần `authenticate` của provider), để nơi gọi đổi kết quả mơ hồ thành 503.
 *
 * `AsyncLocalStorage` của `node:async_hooks` (review M6), không phải CLS của core: điểm ghi là callback `log` của Kysely
 * và `onApiError` (không có DI), và lời gọi provider ngoài HTTP vẫn có scope. Mỗi scope là một object mới, nên request
 * song song không thấy lỗi của nhau; ngoài scope thì không ghi gì. dependency-cruiser coi cả module `async_hooks` là
 * deprecated (API cũ `createHook`/`executionAsyncId` thật sự không khuyến khích), nhưng `AsyncLocalStorage` là API
 * Stable; luật `no-deprecated-core-async-hooks` chỉ miễn đúng import này cho file này và `auth-error-capture.ts`.
 */
const store = new AsyncLocalStorage<Scope>();

export function runWithAuthDbFailureScope<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({}, fn);
}

/**
 * Lỗi hạ tầng của pool auth giải thích được một kết quả MƠ HỒ của Better Auth (500 không `cause`, 401 của session bị
 * nuốt) trong scope hiện tại. `undefined` khi chưa có, HOẶC khi scope đã thấy một lỗi không giải thích được (lỗi lập
 * trình): lúc đó 500 là 500, ném to (review M1).
 */
export function recordedAuthDbFailure(): AuthDbFailure | undefined {
  const scope = store.getStore();
  return scope?.unexplained ? undefined : scope?.failure;
}

/**
 * Spec SP3 T8: path Better Auth (đã bỏ `basePath`) của request mà mount đang phục vụ. `onAPIError.onError(error, ctx)`
 * không có request (router gọi nó sau khi endpoint thoát), nhưng vẫn chạy trong `AsyncLocalStorage` của scope này.
 * Ngoài scope (lời gọi `auth.api.*` của server) không có path: `onError` không đổi lỗi (INT3-4).
 */
export function recordAuthPath(path: string): void {
  const scope = store.getStore();
  if (scope) scope.path = path;
}
export function recordedAuthPath(): string | undefined {
  return store.getStore()?.path;
}

/** Lỗi DB đầu tiên của pool auth trong scope (kể cả lỗi không phải hạ tầng), cho dòng log của 500 thật. */
export function recordedAuthDbError(): AuthDbFailure | undefined {
  return store.getStore()?.dbError;
}

/** Lỗi CHẮC CHẮN đến từ pool `auth_user` (query của Kysely, checkout của pool). */
function recordAuthPoolError(err: unknown): void {
  const scope = store.getStore();
  if (!scope) return;
  scope.dbError ??= safeErrorFields(err);
  if (isAuthInfraError(err)) scope.failure ??= safeErrorFields(err);
}

/**
 * `onApiError` của Better Auth: lỗi gốc của endpoint, gồm lỗi ném từ hook của mình (query thẳng pool auth: directory,
 * reclaimer). Review M2: hook còn chạm Redis và DB app, nên chỉ lỗi MANG DẠNG của pg (`pg.DatabaseError` của server,
 * hoặc `Error` trần với message cố định của pg/pg-pool) mới được tính là lỗi pool auth. DB app đi qua MikroORM, bọc
 * mọi lỗi driver thành exception riêng; Redis (ioredis) có message riêng. `APIError` là kết quả, không phải nguyên nhân.
 *
 * Review N1: lỗi hạ tầng KHÔNG mang dạng pg (lỗi socket trần của Node: ECONNRESET, EPIPE, ETIMEDOUT… mà pg chuyển
 * nguyên cho query đang chạy, connection.js → client.js `_handleErrorEvent`) không quy được về nguồn nào, nên KHÔNG ghi
 * là lỗi pool auth, và cũng KHÔNG bao giờ là "lỗi không giải thích được": đó là sự cố hạ tầng, không phải bug. Nếu nó
 * đến từ pool auth thì `log` của Kysely đã ghi rồi (PgBouncer restart giữa query); nếu không, probe S2-R45 quyết. Chỉ
 * lỗi không phải hạ tầng mới đặt `unexplained` (review M1), nên lỗi hạ tầng đã ghi không bao giờ bị hạ cấp thành 500.
 */
export function recordAuthApiError(err: unknown): void {
  const scope = store.getStore();
  if (!scope || isAPIError(err)) return;
  if (err instanceof pg.DatabaseError || isPgClientInfraError(err))
    recordAuthPoolError(err);
  else if (!isAuthInfraError(err)) scope.unexplained ??= safeErrorFields(err);
}

/**
 * `log` của Kysely cho instance Better Auth: kysely 0.29 bọc `executeQuery` của MỌI connection (query, BEGIN/COMMIT/
 * ROLLBACK) và gọi logger với `{ level: 'error', error }` trong `catch` trước khi ném lại (`driver/runtime-driver.js`,
 * `#addLogging`/`#logError`) — tức là chạy trong chuỗi async của chính lời gọi, trước khi Better Auth nuốt lỗi. Logger
 * dạng hàm bật cả mức `query` (`util/log.js`); mức đó bỏ qua ngay. Không bao giờ ném: logger được `await` trên đường
 * query.
 */
export function authDbQueryLog(event: LogEvent): void {
  if (event.level === 'error') recordAuthPoolError(event.error);
}

/**
 * Review I2: Kysely KHÔNG log lỗi checkout (`acquireConnection` không qua `#addLogging`), và pg-pool 3.14 reject
 * `pool.connect()` bằng `Error('timeout exceeded when trying to connect')` (index.js:224, hết chờ trong hàng đợi) hoặc
 * lỗi kết nối mới (index.js:276-283) — không phát event nào của pool. Nên pool mà Kysely của Better Auth dùng là lớp
 * bọc mỏng: `connect()` ghi lỗi vào scope (continuation `.catch` chạy trong chuỗi async của lời gọi) rồi ném lại.
 * `options`/`Client` chuyển nguyên (Kysely đọc chúng cho `cancelQuery`); `end()` vẫn đóng pool thật.
 */
export function recordingCheckoutPool(pool: pg.Pool): PostgresPool {
  return {
    Client: pg.Client,
    options: pool.options,
    connect: () =>
      pool.connect().catch((err: unknown) => {
        recordAuthPoolError(err);
        throw err;
      }),
    end: () => pool.end(),
  };
}
