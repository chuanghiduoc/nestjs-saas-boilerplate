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
  | 'bulkhead_full';

/**
 * Lỗi của `HttpClient`. Không bao giờ mang body của upstream; message (có tên provider) chỉ để log ở server.
 * Client chỉ thấy problem+json của mã tương ứng, không có `detail` (xem `upstreamErrorMapper`).
 */
export class UpstreamError extends Error {
  readonly status: number | undefined;
  constructor(
    readonly provider: string,
    readonly reason: UpstreamFailure,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'UpstreamError';
    this.status = options.status;
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
        return false;
      default: {
        const unreachable: never = this.reason;
        throw new Error(`Unhandled upstream failure ${String(unreachable)}`);
      }
    }
  }
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
    return new AppError(codeFor(err.reason), { cause: err });
  if (err instanceof SsrfBlockedError)
    return new AppError(CoreErrors.UPSTREAM_ERROR, { cause: err });
  return undefined;
};
