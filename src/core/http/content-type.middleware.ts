import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { BodyParserPolicy } from './body-parser-policy.js';
import { isAllowedContentType, requestHasBody } from './content-type.js';
import { httpConfig } from './http.config.js';
import { requestPath } from './json-body-parser.js';
import { lingerIfBodyUnread } from './unread-body.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Body chỉ được là một trong các Content-Type cho phép, khác → 415. Dưới prefix có chủ (`@BodyParserOwner`) dùng
 * `contentTypes` của chủ đó (vd. upload qua API chỉ nhận `application/octet-stream`); ngoài ra dùng allowlist chung.
 * Chặn cả `application/x-www-form-urlencoded` mà Express vẫn parse mặc định.
 * 415 trả từ header, body chưa đọc: đọc bỏ có giới hạn (`lingerIfBodyUnread`, S2-R50). Đây là đường 415 của
 * các prefix mà core không đọc body (`/api/auth/*`), vì middleware này chạy trước mount.
 */
@Injectable()
export class ContentTypeMiddleware implements NestMiddleware {
  constructor(
    @Inject(httpConfig.KEY)
    private readonly cfg: ConfigOf<typeof httpConfig>,
    private readonly policy: BodyParserPolicy,
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
    const allowed =
      this.policy.ruleFor(requestPath(req))?.contentTypes ??
      this.cfg.allowedContentTypes;
    if (!isAllowedContentType(req.headers, allowed)) {
      lingerIfBodyUnread(req, res, this.cfg);
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${allowed.join(', ')}`,
        }),
      );
    }
    next();
  }
}
