import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { isAllowedContentType, requestHasBody } from './content-type.js';
import { httpConfig } from './http.config.js';
import { lingerIfBodyUnread } from './unread-body.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Body chỉ được là một trong các Content-Type cho phép (mặc định JSON và merge-patch), khác → 415.
 * Chặn cả `application/x-www-form-urlencoded` mà Express vẫn parse mặc định.
 * 415 trả từ header, body chưa đọc: đọc bỏ có giới hạn (`lingerIfBodyUnread`, S2-R50). Đây là đường 415 của
 * prefix mà core không đọc body (`/api/auth/*`), vì middleware này chạy trước mount.
 */
@Injectable()
export class ContentTypeMiddleware implements NestMiddleware {
  constructor(
    @Inject(httpConfig.KEY)
    private readonly cfg: ConfigOf<typeof httpConfig>,
  ) {}

  use(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    if (
      !METHODS_WITH_BODY.has(req.method ?? '') ||
      !requestHasBody(req.headers)
    )
      return next();
    if (!isAllowedContentType(req.headers, this.cfg.allowedContentTypes)) {
      lingerIfBodyUnread(req, res, this.cfg);
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${this.cfg.allowedContentTypes.join(', ')}`,
        }),
      );
    }
    next();
  }
}
