import {
  SsrfBlockedError,
  UpstreamError,
} from '../../../core/resilience/index.js';
import type { AttemptError } from './webhook-delivery.js';

export type AttemptOutcome =
  | { kind: 'DELIVERED'; statusCode: number }
  | {
      kind: 'FAILED';
      error: AttemptError;
      statusCode: number | null;
      retryAfterSec: number | null;
    };

const SUCCESS_MIN = 200;
const REDIRECT_MIN = 300;
const CLIENT_ERROR_MIN = 400;
const failed = (
  error: AttemptError,
  statusCode: number | null = null,
  retryAfterSec: number | null = null,
): AttemptOutcome => ({
  kind: 'FAILED',
  error,
  statusCode,
  retryAfterSec,
});

/**
 * Status trả về bình thường của `HttpClient` (spec §8.3 bước 4): 3xx (không theo redirect) và 4xx khác 429 không ném; 429 và
 * 5xx ném `UpstreamError` (`outcomeOfError`). 1xx không bao giờ tới đây (undici xử lý).
 */
export function outcomeOfStatus(statusCode: number): AttemptOutcome {
  if (statusCode >= SUCCESS_MIN && statusCode < REDIRECT_MIN)
    return { kind: 'DELIVERED', statusCode };
  if (statusCode >= REDIRECT_MIN && statusCode < CLIENT_ERROR_MIN)
    return failed('REDIRECT', statusCode);
  return failed('CLIENT_ERROR', statusCode);
}

/**
 * M7 (review bảo mật 6C): mã lỗi DNS cho thấy resolver của ta tạm thời hỏng (`EAI_AGAIN`, timeout), không phải tên miền của
 * khách sai (`ENOTFOUND` vẫn là lỗi của endpoint). undici bọc lỗi lookup thêm lớp, nên tìm mã trên cả chuỗi `cause`.
 */
const LOCAL_DNS_CODES: ReadonlySet<string> = new Set(['EAI_AGAIN', 'ETIMEOUT']);
const MAX_CAUSE_DEPTH = 5;
function isLocalDnsFailure(err: Error): boolean {
  let cur: unknown = err.cause;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && cur instanceof Error;
    depth++
  ) {
    if (
      'code' in cur &&
      typeof cur.code === 'string' &&
      LOCAL_DNS_CODES.has(cur.code)
    )
      return true;
    cur = cur.cause;
  }
  return false;
}

/** `switch` vét cạn trên `UpstreamFailure`; lỗi khác `UpstreamError`/`SsrfBlockedError` là bug: ném lại, không ghi thành lỗi gửi. */
export function outcomeOfError(err: unknown): AttemptOutcome {
  if (err instanceof SsrfBlockedError) return failed('SSRF_BLOCKED');
  if (!(err instanceof UpstreamError)) throw err;
  const status = err.status ?? null;
  switch (err.reason) {
    case 'bad_status':
      return failed('SERVER_ERROR', status);
    case 'rate_limited':
      return failed('RATE_LIMITED', status, err.retryAfter ?? null);
    case 'timeout':
      return failed('TIMEOUT');
    case 'network':
      return failed(isLocalDnsFailure(err) ? 'DNS_UNAVAILABLE' : 'NETWORK');
    case 'too_large':
      return failed('TOO_LARGE');
    case 'bulkhead_full':
      return failed('BULKHEAD_FULL');
    case 'circuit_open':
      return failed('CIRCUIT_OPEN');
    default: {
      const unreachable: never = err.reason;
      throw new Error(`Unhandled upstream failure ${String(unreachable)}`);
    }
  }
}
