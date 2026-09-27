import { Global, Module } from '@nestjs/common';
import {
  ClsMiddleware,
  ClsModule,
  type ClsMiddlewareOptions,
} from 'nestjs-cls';
import { v7 } from 'uuid';
import {
  currentTraceId,
  currentTraceparent,
} from '../observability/trace-propagation.js';
import { CTX } from './context.keys.js';
import { RequestContext } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';
/** Chỉ nhận request id an toàn để lưu làm clientRequestId (chặn log injection, giới hạn độ dài). */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * `mount: false`: KHÔNG để `ClsModule` tự gắn middleware qua `NestModule.configure()` (SP2 Task 17 fix round).
 * Việc tự gắn đó chỉ chạy TRONG `app.init()`, còn `jsonBodyParser`/`helmet` được `applyHttpDefaults` gắn bằng
 * `app.use()` thủ công TRƯỚC `app.init()` (main.api.ts, test/support/app-factory.ts `beforeInit`) — nên dù khai
 * `mount: true`, CLS luôn được thiết lập SAU `jsonBodyParser`, khiến `RequestContext.requestId()` đọc được lúc
 * `jsonBodyParser` trả lỗi (400/413/415, qua `ProblemDetailsFilter`) luôn là "none". `applyHttpDefaults` gắn
 * `contextMiddleware()` bằng tay làm `app.use()` ĐẦU TIÊN để đảm bảo đúng thứ tự, không phụ thuộc thời điểm
 * `configure()` của Nest chạy.
 */
const clsMiddlewareOptions: ClsMiddlewareOptions = {
  mount: false,
  setup: (
    cls,
    req: {
      headers: Record<string, string | undefined>;
      originalUrl: string;
    },
    res: { setHeader(k: string, v: string): void },
  ) => {
    const requestId = v7();
    const incoming = req.headers[REQUEST_ID_HEADER];
    cls.set(CTX.requestId, requestId);
    if (incoming && CLIENT_REQUEST_ID_PATTERN.test(incoming))
      cls.set(CTX.clientRequestId, incoming);
    cls.set(CTX.path, req.originalUrl.split('?')[0]);
    // Span HTTP do auto-instrumentation tạo đã active ở đây. `traceparent` của client chỉ vào
    // context qua propagator của OTel (đã lấy mẫu lại), không copy thẳng header.
    cls.set(CTX.traceId, currentTraceId());
    cls.set(CTX.traceparent, currentTraceparent());
    res.setHeader('X-Request-Id', requestId);
  },
};

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: clsMiddlewareOptions,
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class ContextModule {}

/**
 * Middleware Node thiết lập CLS request context cho HTTP app (request id, path, trace…), cùng `setup` với module
 * (`clsMiddlewareOptions`). `applyHttpDefaults` (core/http) phải gắn middleware này bằng `app.use()` TRƯỚC
 * `jsonBodyParser`, để parser và mọi middleware sau đó đọc được `RequestContext` (xem comment ở
 * `clsMiddlewareOptions`). Mỗi lần gọi trả một instance mới (không giữ state ngoài `options`), an toàn để gọi lại
 * cho mỗi app (nhiều app song song trong test).
 */
export function contextMiddleware(): ClsMiddleware['use'] {
  return new ClsMiddleware(clsMiddlewareOptions).use;
}
