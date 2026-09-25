import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  TimeoutStrategy,
  bulkhead,
  circuitBreaker,
  fullJitterGenerator,
  handleWhen,
  isBrokenCircuitError,
  isBulkheadRejectedError,
  retry,
  timeout,
  wrap,
  type IPolicy,
} from 'cockatiel';
import { SsrfBlockedError } from './ssrf-guard.js';
import { UpstreamError } from './upstream-error.js';

/**
 * Chỉ lỗi tạm thời mới retry và tính vào breaker. SSRF bị chặn, response quá lớn, breaker mở và
 * bulkhead đầy là quyết định chính sách: retry chỉ tốn thêm tài nguyên.
 */
export const isTransient = (e: unknown): boolean => {
  if (e instanceof SsrfBlockedError) return false;
  if (e instanceof Error && e.cause instanceof SsrfBlockedError) return false;
  if (e instanceof UpstreamError) return e.transient;
  return !isBrokenCircuitError(e) && !isBulkheadRejectedError(e);
};

export type PolicyConfig = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
  breakerThreshold: number;
  breakerHalfOpenMs: number;
  bulkheadLimit: number;
  bulkheadQueue: number;
};

/**
 * Hai biến thể dùng chung breaker và bulkhead: `retrying` cho method idempotent, `single` cho phần còn lại.
 * Thứ tự (ngoài → trong): bulkhead → retry → breaker → timeout, nên timeout tính theo từng lần thử
 * và breaker đếm từng lần thử thất bại. Backoff là full jitter (delay ngẫu nhiên trong [0, base·2^n)).
 */
export function buildPolicies(c: PolicyConfig): {
  retrying: IPolicy;
  single: IPolicy;
} {
  const breakerP = circuitBreaker(handleWhen(isTransient), {
    halfOpenAfter: c.breakerHalfOpenMs,
    breaker: new ConsecutiveBreaker(c.breakerThreshold),
  });
  const bulkheadP = bulkhead(c.bulkheadLimit, c.bulkheadQueue);
  const timeoutP = timeout(c.timeoutMs, TimeoutStrategy.Aggressive);
  const retryP = retry(handleWhen(isTransient), {
    maxAttempts: c.retries,
    backoff: new ExponentialBackoff({
      initialDelay: c.retryBaseMs,
      generator: fullJitterGenerator,
    }),
  });
  return {
    retrying: wrap(bulkheadP, retryP, breakerP, timeoutP),
    single: wrap(bulkheadP, breakerP, timeoutP),
  };
}
