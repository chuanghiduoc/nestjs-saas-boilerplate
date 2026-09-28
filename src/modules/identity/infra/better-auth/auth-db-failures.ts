import {
  getAsyncLocalStorage,
  type AsyncLocalStorage,
} from '@better-auth/core/async_hooks';
import type { LogEvent } from 'kysely';
import { safeErrorFields } from '../../identity-telemetry.js';
import { isAuthInfraError } from './auth-error.mapper.js';

export type AuthDbFailure = ReturnType<typeof safeErrorFields>;
type Scope = { failure?: AuthDbFailure };

/**
 * S2-R65: Better Auth NUỐT lỗi gốc của storage (`getSession` → `APIError(500, FAILED_TO_GET_SESSION)` không `cause`,
 * `verifyApiKey` → `INVALID_API_KEY`), nên một query bị huỷ khi DB vẫn khoẻ (57014 do lock/statement_timeout, `Query
 * read timeout` của S2-R60, connection bị cắt) qua được probe S2-R45 và thành 500. Lỗi hạ tầng của query auth được ghi
 * vào một scope theo TỪNG lời gọi vào Better Auth (một request của mount, một lần `authenticate` của provider), để
 * nơi gọi đổi 500 mơ hồ thành 503.
 *
 * `AsyncLocalStorage` riêng (không phải CLS của core): điểm ghi là callback `log` của Kysely, không có DI, và lời gọi
 * provider ngoài HTTP (test, job) vẫn có scope. Mỗi scope là một object mới do `runWithAuthDbFailureScope` tạo, nên
 * request song song không bao giờ thấy lỗi của nhau; ngoài scope thì không ghi gì. Lớp `AsyncLocalStorage` lấy qua
 * `@better-auth/core/async_hooks` như `auth-error-capture.ts` (luật `no-deprecated-core` của dependency-cruiser chặn
 * import `node:async_hooks` trực tiếp).
 */
let store: AsyncLocalStorage<Scope> | undefined;
const ready = getAsyncLocalStorage().then((ALS) => {
  store = new ALS<Scope>();
  return store;
});

export async function runWithAuthDbFailureScope<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return (await ready).run({}, fn);
}

/** Lỗi hạ tầng đầu tiên đã ghi trong scope hiện tại (chỉ lớp + SQLSTATE/mã, không message: spec §5.14). */
export function recordedAuthDbFailure(): AuthDbFailure | undefined {
  return store?.getStore()?.failure;
}

/** Chỉ lớp lỗi hạ tầng (`isAuthInfraError`: 57014, 08*, 53*, 57P0*, socket, `Query read timeout`…); lỗi khác bỏ qua. */
export function recordAuthDbFailure(err: unknown): void {
  const scope = store?.getStore();
  if (scope && !scope.failure && isAuthInfraError(err))
    scope.failure = safeErrorFields(err);
}

/**
 * `log` của Kysely cho instance Better Auth: kysely 0.29 bọc `executeQuery` của MỌI connection (query, BEGIN/COMMIT/
 * ROLLBACK) và gọi logger với `{ level: 'error', error }` trong `catch` trước khi ném lại (`driver/runtime-driver.js`,
 * `#addLogging`/`#logError`) — tức là chạy trong chuỗi async của chính lời gọi, trước khi Better Auth nuốt lỗi. Logger
 * dạng hàm bật cả mức `query` (`util/log.js`); mức đó bỏ qua ngay. Không bao giờ ném: logger được `await` trên đường
 * query.
 */
export function authDbQueryLog(event: LogEvent): void {
  if (event.level === 'error') recordAuthDbFailure(event.error);
}
