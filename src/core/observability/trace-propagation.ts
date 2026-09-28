import {
  SpanStatusCode,
  context,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';
import { AppError } from '../errors/index.js';

const TRACER = 'core';

/** Mã an toàn của lỗi: mã `AppError`, không thì `code` dạng chuỗi (SQLSTATE, mã socket); không bao giờ message. */
function errorCode(err: unknown): string | undefined {
  if (err instanceof AppError) return err.error.code;
  return typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string'
    ? err.code
    : undefined;
}

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
        // Chỉ lớp lỗi và mã (SQLSTATE, mã `AppError`): message/stack của lỗi job (SMTP, pg, Better Auth) có thể chứa
        // email/token và đường dẫn nội bộ, và sẽ bị export ra OTLP nếu `recordException(err)` (Task 40 concern 4).
        const type = err instanceof Error ? err.constructor.name : typeof err;
        const code = errorCode(err);
        // Event `exception` chỉ mang `exception.type` = tên lớp; mã nằm ở attribute `error.code`.
        span.recordException({ name: type });
        span.setAttributes(
          code
            ? { 'error.type': type, 'error.code': code }
            : { 'error.type': type },
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
