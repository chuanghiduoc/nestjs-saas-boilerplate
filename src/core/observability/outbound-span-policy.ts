import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';

type UndiciConfig = NonNullable<
  InstrumentationConfigMap['@opentelemetry/instrumentation-undici']
>;
/** Request của undici như hook nhận (types của `@opentelemetry/instrumentation-undici` 0.32.0, `UndiciRequest`). */
type UndiciRequest = Parameters<
  NonNullable<UndiciConfig['ignoreRequestHook']>
>[0];

/**
 * Header chữ ký của Standard Webhooks (spec SP6 §8.3): mọi lần gửi webhook ra ngoài đều mang nó, request nào khác của app thì
 * không. Dùng nó làm dấu nhận biết (không thêm header riêng nào gửi sang khách) để không bao giờ trace request webhook.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/** undici v5 cho header dạng chuỗi `name: value\r\n`; v6+ dạng mảng `[name, value, …]` (name có thể khác hoa thường). */
function hasHeader(req: UndiciRequest, name: string): boolean {
  const { headers } = req;
  if (typeof headers === 'string')
    return headers
      .split('\r\n')
      .some(
        (line) =>
          line.slice(0, line.indexOf(':')).trim().toLowerCase() === name,
      );
  for (let i = 0; i < headers.length; i += 2) {
    const key = headers[i];
    if (typeof key === 'string' && key.toLowerCase() === name) return true;
  }
  return false;
}

/** `url.full` không có query (query có thể mang token của bên thứ ba); `undefined` khi không dựng được URL. */
function withoutQuery(req: UndiciRequest): string | undefined {
  try {
    const url = new URL(req.path, req.origin);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Chính sách span của request ra ngoài (review cuối 6C I-A, spec SP6 §15):
 * - request webhook (URL do khách cấu hình, path/query có thể chứa token, host là cardinality vô hạn) không có span client và
 *   không có điểm metric `http.client.request.duration`; span cha `integrations.deliver` vẫn có, không mang URL;
 * - mọi request khác giữ span và metric, nhưng `url.full` bỏ query và không có `url.query`. Giá trị `undefined` của
 *   `startSpanHook` ghi đè attribute mặc định, và SDK bỏ attribute `undefined` khi tạo span.
 */
export const undiciInstrumentationConfig: UndiciConfig = {
  ignoreRequestHook: (req) => hasHeader(req, WEBHOOK_SIGNATURE_HEADER),
  startSpanHook: (req) => ({
    'url.full': withoutQuery(req),
    'url.query': undefined,
  }),
};
