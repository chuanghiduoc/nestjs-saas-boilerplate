import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { contextMiddleware } from '../context/index.js';
import {
  AppError,
  CoreErrors,
  zodIssuesToFields,
  type ZodIssueLike,
} from '../errors/index.js';
import { BodyParserPolicy } from './body-parser-policy.js';
import { httpConfig } from './http.config.js';
import { jsonBodyParser } from './json-body-parser.js';

const isExpressApp = (app: INestApplication): app is NestExpressApplication =>
  app.getHttpAdapter().getType() === 'express';

/**
 * Mặc định HTTP cho app API. Chỗ **duy nhất** biết nền tảng là Express (import `@nestjs/platform-express`).
 * Gọi trước `app.init()`/`listen()`. App tạo với `bodyParser: false` (main.api.ts); parser JSON của core
 * (`jsonBodyParser`, `raw-body`) đăng ký bằng `app.use`, trả lỗi qua `next(AppError)` để `ProblemDetailsFilter`
 * render như mọi lỗi khác.
 */
export function applyHttpDefaults(app: INestApplication): void {
  if (!isExpressApp(app))
    throw new Error(
      `applyHttpDefaults supports the Express adapter only, got "${app.getHttpAdapter().getType()}"`,
    );
  const cfg = httpConfig();
  app.set('trust proxy', cfg.trustProxy);
  app.set('etag', 'weak');
  // Phải là app.use() ĐẦU TIÊN (SP2 Task 17 fix round): thiết lập CLS request context trước khi bất kỳ middleware
  // nào (đặc biệt `jsonBodyParser`) có thể đọc/ghi `RequestContext`. `ContextModule` khai `mount: false` đúng vì
  // lý do này — xem comment ở `clsMiddlewareOptions` (core/context/context.module.ts).
  app.use(contextMiddleware());
  // Không dùng `useBodyParser` (body-parser chờ hết body khi vượt limit, review B1): parser giới hạn theo stream.
  app.use(
    jsonBodyParser(cfg, {
      skipPathPrefixes: app
        .get(BodyParserPolicy)
        .rules()
        .map((r) => r.prefix),
    }),
  );
  app.use(helmet());
  if (cfg.corsOrigins.length)
    app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues: readonly ZodIssueLike[]) =>
        new AppError(CoreErrors.VALIDATION_FAILED, {
          detail: 'One or more fields did not pass validation.',
          fields: zodIssuesToFields(issues),
        }),
    }),
  );
}
