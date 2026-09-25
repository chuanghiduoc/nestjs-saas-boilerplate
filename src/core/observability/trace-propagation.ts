import {
  SpanStatusCode,
  context,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';

const TRACER = 'core';

/** W3C `traceparent` của span đang active; không có span hợp lệ (hoặc OTel tắt) thì undefined. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Trace id của span đang active; không ghi id toàn số 0 của span no-op (OTel tắt). */
export function currentTraceId(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && isSpanContextValid(sc) ? sc.traceId : undefined;
}

/**
 * Chạy `fn` trong một span mới, con của `traceparent` (parent từ xa: job, event); không có thì
 * span gốc mới. Lỗi được ghi vào span rồi ném lại nguyên vẹn.
 */
export async function withRemoteParent<T>(
  traceparent: string | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceparent
    ? propagation.extract(context.active(), { traceparent })
    : context.active();
  return trace
    .getTracer(TRACER)
    .startActiveSpan(name, {}, parent, async (span) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof Error) span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
