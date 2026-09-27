import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const IDENTITY_METER = 'identity';
export const IDENTITY_TRACER = 'identity';

/** Tên class của lỗi (không phải `err.name`, có thể bị gán tuỳ ý); giá trị ném không phải Error thì `typeof`. */
const errorClass = (err: unknown): string =>
  err instanceof Error ? err.constructor.name : typeof err;

/**
 * Chạy `fn` trong span con của span đang active (request HTTP, job). Attribute chỉ gồm phân loại
 * (kind/result), không email/user id/token (spec §5.14). Lỗi ném lại nguyên vẹn, nhưng span chỉ nhận
 * tên class và mã `AppError` (ruling S2-R30): message/stack của lỗi (vd. `APIError` của Better Auth)
 * có thể chứa email/token và sẽ bị export ra OTLP nếu `recordException(err)`.
 */
export async function identitySpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrsOf?: (result: T) => Attributes,
): Promise<T> {
  return trace
    .getTracer(IDENTITY_TRACER)
    .startActiveSpan(name, async (span) => {
      try {
        const result = await fn();
        if (attrsOf) span.setAttributes(attrsOf(result));
        return result;
      } catch (err) {
        const type = errorClass(err);
        const code = err instanceof AppError ? err.error.code : undefined;
        // Event `exception` chỉ có `exception.type` (mã AppError nếu có, không thì tên class): không message, không stack.
        span.recordException(code ? { name: type, code } : { name: type });
        span.setAttributes(
          code
            ? { 'error.type': type, 'identity.error_code': code }
            : { 'error.type': type },
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
