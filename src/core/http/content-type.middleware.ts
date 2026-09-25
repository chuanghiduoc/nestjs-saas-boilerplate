import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { httpConfig } from './http.config.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

type RequestLike = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
};
const header = (req: RequestLike, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
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
    const hasBody =
      Number(header(req, 'content-length') ?? 0) > 0 ||
      header(req, 'transfer-encoding') !== undefined;
    if (!METHODS_WITH_BODY.has(req.method) || !hasBody) return next();
    const type = (header(req, 'content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!this.cfg.allowedContentTypes.includes(type))
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${this.cfg.allowedContentTypes.join(', ')}`,
        }),
      );
    next();
  }
}
