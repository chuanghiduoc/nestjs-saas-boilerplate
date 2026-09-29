import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const TENANCY_METER = 'tenancy';
export const TENANCY_TRACER = 'tenancy';

/**
 * Span con của span đang active (spec SP3 §16). Attribute chỉ là enum hữu hạn (không org, user, email, token); lỗi chỉ
 * ghi tên class và mã `AppError`, không message/stack (cùng luật S2-R30 của identity).
 */
export async function tenancySpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrsOf?: (result: T) => Attributes,
): Promise<T> {
  return trace.getTracer(TENANCY_TRACER).startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      if (attrsOf) span.setAttributes(attrsOf(result));
      return result;
    } catch (err) {
      const type = err instanceof Error ? err.constructor.name : typeof err;
      const code = err instanceof AppError ? err.error.code : undefined;
      span.recordException(code ? { name: type, code } : { name: type });
      span.setAttributes(
        code
          ? { 'error.type': type, 'tenancy.error_code': code }
          : { 'error.type': type },
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
