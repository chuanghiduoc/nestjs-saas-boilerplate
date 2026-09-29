import { trace, type Attributes, type Span } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const ENTITLEMENTS_METER = 'entitlements';
export const ENTITLEMENTS_TRACER = 'entitlements';

/**
 * Span con của span đang active (spec §19). Attribute chỉ là enum hữu hạn hoặc key tính năng (catalogue hữu hạn): không
 * org, user, `reason`, `plan_source_ref`; lỗi chỉ ghi tên class và mã `AppError` (cùng luật của `tenancySpan`). `fn` nhận
 * span để đặt attribute trên nhánh ném lỗi có chủ đích (vd. `entitlements.result = denied` trước khi ném 403).
 */
export async function entitlementsSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrsOf?: (result: T) => Attributes,
): Promise<T> {
  return trace
    .getTracer(ENTITLEMENTS_TRACER)
    .startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);
        if (attrsOf) span.setAttributes(attrsOf(result));
        return result;
      } catch (err) {
        const type = err instanceof Error ? err.constructor.name : typeof err;
        const code = err instanceof AppError ? err.error.code : undefined;
        span.recordException(code ? { name: type, code } : { name: type });
        span.setAttributes(
          code
            ? { 'error.type': type, 'entitlements.error_code': code }
            : { 'error.type': type },
        );
        throw err;
      } finally {
        span.end();
      }
    });
}
