import { getAsyncLocalStorage } from '@better-auth/core/async_hooks';
import { safeErrorFields } from '../../identity-telemetry.js';

export type CapturedAuthError = ReturnType<typeof safeErrorFields>;
type Holder = { error?: CapturedAuthError };
type Store = {
  run<R>(store: Holder, fn: () => R): R;
  getStore(): Holder | undefined;
};

/**
 * Task 40 N7: `auth_endpoint_error` của mount chỉ thấy `Response` 5xx; lớp lỗi thật chỉ có trong `onAPIError.onError`
 * của Better Auth, chạy BÊN TRONG `auth.handler(request)` mà mount gọi. Mount chạy handler trong một scope riêng
 * (`captureAuthError`), hook ghi `safeErrorFields` vào scope đó (`recordAuthError`) — chỉ lớp lỗi + mã (SQLSTATE,
 * mã `AppError`), không message/stack (spec §5.14). Ngoài scope (lời gọi `auth.api.*` trực tiếp) thì không ghi gì.
 *
 * AsyncLocalStorage lấy qua `@better-auth/core/async_hooks` (cùng nguồn Better Auth dùng cho request state của nó),
 * không import `node:async_hooks` trực tiếp. Không dùng request state của Better Auth (`defineRequestState`): scope của
 * nó chỉ bọc lời gọi endpoint, còn `onError` của router chạy SAU khi lỗi đã ra khỏi scope đó.
 */
let store: Store | undefined;
const ready = getAsyncLocalStorage().then((ALS) => {
  store = new ALS<Holder>();
  return store;
});

export async function captureAuthError<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; error?: CapturedAuthError }> {
  const s = await ready;
  const holder: Holder = {};
  const result = await s.run(holder, fn);
  return holder.error ? { result, error: holder.error } : { result };
}

export function recordAuthError(err: unknown): void {
  const holder = store?.getStore();
  if (holder) holder.error = safeErrorFields(err);
}
