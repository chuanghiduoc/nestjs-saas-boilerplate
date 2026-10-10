import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const INTEGRATIONS_METER = 'integrations';
const INTEGRATIONS_TRACER = 'integrations';

/** Span con (spec SP6 §15): attribute chỉ là enum hữu hạn; không org, URL, body; lỗi chỉ ghi tên class và mã `AppError`. */
export async function integrationsSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrsOf?: (result: T) => Attributes,
): Promise<T> {
  return trace
    .getTracer(INTEGRATIONS_TRACER)
    .startActiveSpan(name, async (span) => {
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
            ? { 'error.type': type, 'integrations.error_code': code }
            : { 'error.type': type },
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
