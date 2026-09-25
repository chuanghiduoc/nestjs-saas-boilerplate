import {
  AppError,
  CoreErrors,
  type ErrorCode,
  type ErrorMapper,
} from '../errors/index.js';
import { SsrfBlockedError } from './ssrf-guard.js';

/** Lý do một lời gọi ra ngoài thất bại; quyết định retry và mã lỗi trả cho client. */
export type UpstreamFailure =
  | 'bad_status'
  | 'too_large'
  | 'network'
  | 'timeout'
  | 'circuit_open'
  | 'bulkhead_full'
  | 'rate_limited';

/**
 * Lỗi của `HttpClient`. Không bao giờ mang body của upstream; message (có tên provider) chỉ để log ở server.
 * Client chỉ thấy problem+json của mã tương ứng, không có `detail` (xem `upstreamErrorMapper`).
 */
export class UpstreamError extends Error {
  readonly status: number | undefined;
  /**
   * Retry-After của upstream (chỉ với rate_limited) theo giây, đã chặn trần
   * `RESILIENCE_RETRY_AFTER_MAX_SEC` (xem `parseRetryAfterSec`); caller/job queue dùng để lùi lịch,
   * mapper trả nó cho client trong header `Retry-After`.
   */
  readonly retryAfter: number | undefined;
  constructor(
    readonly provider: string,
    readonly reason: UpstreamFailure,
    message: string,
    options: { status?: number; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'UpstreamError';
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }

  /** Lỗi tạm thời đáng retry và đáng tính vào breaker. */
  get transient(): boolean {
    switch (this.reason) {
      case 'bad_status':
      case 'network':
      case 'timeout':
        return true;
      case 'too_large':
      case 'circuit_open':
      case 'bulkhead_full':
      case 'rate_limited':
        return false;
      default: {
        const unreachable: never = this.reason;
        throw new Error(`Unhandled upstream failure ${String(unreachable)}`);
      }
    }
  }
}

const MS_PER_SECOND = 1000;
const DELTA_SECONDS = /^\d+$/;
/** Ba dạng HTTP-date của RFC 9110 §5.6.7: IMF-fixdate, rfc850 (GMT) và asctime (không ghi zone, là GMT). */
const IMF_FIXDATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE =
  /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

function httpDateMs(value: string): number | undefined {
  const ms =
    IMF_FIXDATE.test(value) || RFC850_DATE.test(value)
      ? Date.parse(value)
      : ASCTIME_DATE.test(value)
        ? Date.parse(`${value} GMT`)
        : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Header Retry-After (RFC 9110 §10.2.3: delta-seconds hoặc HTTP-date) thành số giây nguyên, chặn
 * trần `maxSec` (upstream không được đẩy lịch của mình đi quá xa); mốc đã qua thì 0. Giá trị không
 * đúng cú pháp (vd. `1.5`, `-5`, mà `Date.parse` vẫn nhận thành ngày) là không biết: `undefined`.
 */
export function parseRetryAfterSec(
  value: string | undefined,
  maxSec: number,
  nowMs: number = Date.now(),
): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let sec: number;
  if (DELTA_SECONDS.test(v)) sec = Number(v);
  else {
    const at = httpDateMs(v);
    if (at === undefined) return undefined;
    sec = Math.max(0, Math.ceil((at - nowMs) / MS_PER_SECOND));
  }
  return Math.min(sec, maxSec);
}

function codeFor(reason: UpstreamFailure): ErrorCode {
  switch (reason) {
    case 'bad_status':
    case 'too_large':
    case 'network':
      return CoreErrors.UPSTREAM_ERROR;
    case 'timeout':
      return CoreErrors.UPSTREAM_TIMEOUT;
    case 'circuit_open':
    case 'bulkhead_full':
    case 'rate_limited':
      return CoreErrors.SERVICE_UNAVAILABLE;
    default: {
      const unreachable: never = reason;
      throw new Error(`Unhandled upstream failure ${String(unreachable)}`);
    }
  }
}

/** Không truyền `detail`: URL/IP nội bộ và body upstream không bao giờ tới client. */
export const upstreamErrorMapper: ErrorMapper = (err) => {
  if (err instanceof UpstreamError)
    return new AppError(codeFor(err.reason), {
      cause: err,
      // Spec gốc §3.2: 503 "có Retry-After khi biết".
      ...(err.retryAfter !== undefined
        ? { headers: { 'Retry-After': String(err.retryAfter) } }
        : {}),
    });
  if (err instanceof SsrfBlockedError)
    return new AppError(CoreErrors.UPSTREAM_ERROR, { cause: err });
  return undefined;
};
