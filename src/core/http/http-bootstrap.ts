import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import {
  AppError,
  CoreErrors,
  zodIssuesToFields,
  type ZodIssueLike,
} from '../errors/index.js';
import { httpConfig } from './http.config.js';

const isExpressApp = (app: INestApplication): app is NestExpressApplication =>
  app.getHttpAdapter().getType() === 'express';

/**
 * Mặc định HTTP cho app API. Chỗ **duy nhất** biết nền tảng là Express (import `@nestjs/platform-express`).
 * Gọi trước `app.init()`/`listen()`: body parser JSON đăng ký ở đây thay cho parser JSON mặc định của Nest
 * (Nest bỏ qua parser mặc định khi đã có middleware tên `jsonParser`).
 */
export function applyHttpDefaults(app: INestApplication): void {
  if (!isExpressApp(app))
    throw new Error(
      `applyHttpDefaults supports the Express adapter only, got "${app.getHttpAdapter().getType()}"`,
    );
  const cfg = httpConfig();
  app.set('trust proxy', cfg.trustProxy);
  app.set('etag', 'weak');
  app.useBodyParser('json', {
    type: cfg.allowedContentTypes,
    limit: cfg.bodyLimit,
  });
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
