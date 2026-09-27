import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

export const IDENTITY_METER = 'identity';
export const IDENTITY_TRACER = 'identity';

/**
 * Chạy `fn` trong span con của span đang active (request HTTP, job). Attribute chỉ gồm phân loại
 * (kind/result), không email/user id/token (spec §5.14). Lỗi ghi vào span rồi ném lại nguyên vẹn.
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
        if (err instanceof Error) span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
