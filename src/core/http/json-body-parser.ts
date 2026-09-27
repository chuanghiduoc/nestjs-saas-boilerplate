import type { IncomingMessage, ServerResponse } from 'node:http';
import getRawBody from 'raw-body';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import {
  charsetOf,
  firstHeader,
  isAllowedContentType,
  requestHasBody,
} from './content-type.js';
import type { httpConfig } from './http.config.js';

export type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const UTF8 = 'utf-8';
const IDENTITY = 'identity';
/** Như `strict: true` của body-parser: chỉ nhận object hoặc array ở gốc. */
const STRICT_JSON_START = /^[\s]*[{[]/;
/** Thời gian chờ client tự đóng sau FIN của 413 trước khi huỷ socket (review NM3). */
const SOCKET_CLOSE_GRACE_MS = 1000;
const RAW_BODY_TOO_LARGE = 'entity.too.large';

/**
 * Path gốc của request. Express cắt mount path khỏi `req.url` khi middleware gắn theo path
 * (spike S1: `url` là `/`, `originalUrl` là `/api/auth/sign-up/email`), nên ưu tiên `originalUrl`.
 */
const originalPath = (req: IncomingMessage): string => {
  const url =
    'originalUrl' in req && typeof req.originalUrl === 'string'
      ? req.originalUrl
      : (req.url ?? '');
  return url.split('?')[0] ?? '';
};

/**
 * Parser JSON giới hạn theo STREAM (review B1): `raw-body` đếm byte khi dữ liệu còn đang tới và dừng ngay khi
 * vượt `HTTP_BODY_LIMIT` (unpipe + pause), kể cả body chunked không có Content-Length. Khi đó response 413
 * mang `Connection: close` và socket được đóng ngay sau khi response gửi xong — không đọc tiếp, không chờ `end`.
 * Chỉ nhận body `identity`, `utf-8`, JSON object/array; lỗi luôn đi qua `next(AppError)`.
 */
export function jsonBodyParser(
  cfg: ConfigOf<typeof httpConfig>,
  opts: { skipPathPrefix?: string } = {},
): NodeMiddleware {
  const prefix = opts.skipPathPrefix;
  const unsupported = (detail: string) =>
    new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, { detail });
  return (req, res, next) => {
    const path = originalPath(req);
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`)))
      return next();
    if (
      METHODS_WITHOUT_BODY.has(req.method ?? '') ||
      !requestHasBody(req.headers)
    )
      return next();
    if (!isAllowedContentType(req.headers, cfg.allowedContentTypes))
      return next(
        unsupported(
          `Content-Type must be one of: ${cfg.allowedContentTypes.join(', ')}`,
        ),
      );
    if (
      (
        firstHeader(req.headers, 'content-encoding') ?? IDENTITY
      ).toLowerCase() !== IDENTITY
    )
      return next(unsupported('Content-Encoding must be identity'));
    if ((charsetOf(req.headers) ?? UTF8) !== UTF8)
      return next(unsupported('charset must be utf-8'));
    getRawBody(
      req,
      {
        limit: cfg.bodyLimit,
        length: firstHeader(req.headers, 'content-length'),
      },
      (err, buf) => {
        if (err) {
          if (err.type === RAW_BODY_TOO_LARGE) {
            res.setHeader('Connection', 'close');
            // Review NM3: `destroy()` ngay khi client còn gửi có thể làm kernel gửi RST và client mất 413 đã nhận.
            // `end()` gửi FIN sau response; client đóng theo `Connection: close`. Hạn chót cứng nếu client không đóng.
            res.once('finish', () => {
              const socket = req.socket;
              socket.end();
              const deadline = setTimeout(
                () => socket.destroy(),
                SOCKET_CLOSE_GRACE_MS,
              ).unref();
              socket.once('close', () => clearTimeout(deadline));
            });
            return next(
              new AppError(CoreErrors.PAYLOAD_TOO_LARGE, {
                detail: `Body exceeds ${cfg.bodyLimit}`,
              }),
            );
          }
          // Client huỷ giữa chừng, Content-Length sai…: request không đọc được.
          return next(
            new AppError(CoreErrors.MALFORMED_REQUEST, {
              detail: 'Request body could not be read',
            }),
          );
        }
        const text = buf.toString('utf8');
        let body: unknown;
        try {
          if (!STRICT_JSON_START.test(text))
            throw new SyntaxError('not an object or array');
          body = JSON.parse(text);
        } catch {
          return next(
            new AppError(CoreErrors.MALFORMED_REQUEST, {
              detail: 'Request body must be a JSON object or array',
            }),
          );
        }
        Object.assign(req, { body, rawBody: buf });
        next();
      },
    );
  };
}
