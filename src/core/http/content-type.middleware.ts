import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { isAllowedContentType, requestHasBody } from './content-type.js';
import { httpConfig } from './http.config.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

type RequestLike = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Body chỉ được là một trong các Content-Type cho phép (mặc định JSON và merge-patch), khác → 415.
 * Chặn cả `application/x-www-form-urlencoded` mà Express vẫn parse mặc định.
 */
@Injectable()
export class ContentTypeMiddleware implements NestMiddleware {
  constructor(
    @Inject(httpConfig.KEY)
    private readonly cfg: ConfigOf<typeof httpConfig>,
  ) {}

  use(req: RequestLike, _res: unknown, next: (err?: unknown) => void): void {
    if (!METHODS_WITH_BODY.has(req.method) || !requestHasBody(req.headers))
      return next();
    if (!isAllowedContentType(req.headers, this.cfg.allowedContentTypes))
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${this.cfg.allowedContentTypes.join(', ')}`,
        }),
      );
    next();
  }
}
