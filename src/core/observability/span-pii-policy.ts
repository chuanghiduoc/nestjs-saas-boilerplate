import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * Attribute luôn bị bỏ: có thể mang giá trị thật.
 * - `db.query.text`: MikroORM 7 chèn giá trị tham số vào chuỗi SQL (`platform.formatQuery`) trước khi tới `pg`, nên
 *   instrumentation pg ghi câu SQL có literal (email, token…); ioredis ghi tham số lệnh (key, value, tham số EVALSHA của
 *   BullMQ). Không instrumentation nào có option tắt attribute này (pg 0.74 không có serializer).
 * - `db.statement`: tên cũ của cùng attribute (semconv trước 1.26), bỏ luôn nếu một instrumentation còn ghi.
 * - `url.query`: query của request (token xác thực email của Better Auth, cursor, bộ lọc).
 */
const DROPPED_ATTRIBUTES = ['db.query.text', 'db.statement', 'url.query'];
/** Path của request vào có thể chứa secret (Better Auth `/reset-password/:token`); `http.route` giữ mẫu route. */
const DROPPED_SERVER_ATTRIBUTES = ['url.path'];
/** Event `exception` chỉ giữ tên lớp lỗi: message và stack có thể lặp lại giá trị (Postgres 22P02, Redis `unknown command`). */
const KEPT_EXCEPTION_ATTRIBUTES = ['exception.type'];

/** Bỏ query và fragment; nhận cả URL tuyệt đối (undici) lẫn tương đối (`req.originalUrl` của instrumentation nestjs-core). */
function withoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function scrubAttributes(span: ReadableSpan): ReadableSpan['attributes'] {
  const attributes = { ...span.attributes };
  for (const key of DROPPED_ATTRIBUTES) delete attributes[key];
  if (span.kind === SpanKind.SERVER)
    for (const key of DROPPED_SERVER_ATTRIBUTES) delete attributes[key];
  const url = attributes['url.full'];
  if (typeof url === 'string') attributes['url.full'] = withoutQuery(url);
  return attributes;
}

function scrubEvents(span: ReadableSpan): ReadableSpan['events'] {
  return span.events.map((event) =>
    event.name === 'exception'
      ? {
          ...event,
          attributes: Object.fromEntries(
            Object.entries(event.attributes ?? {}).filter(([key]) =>
              KEPT_EXCEPTION_ATTRIBUTES.includes(key),
            ),
          ),
        }
      : event,
  );
}

/**
 * Bản sao của span không còn giá trị nào lấy từ dữ liệu: giữ tên span, kind, thời gian, `db.system.name`,
 * `db.operation.name`, `http.route`, mã trạng thái; bỏ text truy vấn, query/path của URL, message lỗi (`status.message`
 * của pg là `err.message` của Postgres, có thể chứa nguyên giá trị).
 */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: scrubAttributes(span),
    links: span.links,
    events: scrubEvents(span),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * Exporter của production bọc exporter OTLP (spec §15: span không mang PII hay secret). Lọc ở đây, một chỗ cho mọi
 * instrumentation, vì pg và nestjs-core không có option/hook nào bỏ được attribute mang giá trị, và message lỗi được
 * đặt ở đường lỗi không có hook. Bọc exporter (không thay span processor) để NodeSDK vẫn tự dựng `BatchSpanProcessor`
 * theo env như trước.
 */
export class PiiScrubbingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter['export']>[1],
  ): void {
    this.inner.export(spans.map(scrubSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
