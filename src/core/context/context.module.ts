import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
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

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
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
      },
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class ContextModule {}
