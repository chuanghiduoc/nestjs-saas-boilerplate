import type { IncomingMessage, ServerResponse } from 'node:http';
import parseurl from 'parseurl';
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
import {
  lingerIfBodyUnread,
  lingerUnreadBody,
  remainingDeclaredBytes,
} from './unread-body.js';

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
const RAW_BODY_TOO_LARGE = 'entity.too.large';
/**
 * Lỗi lập trình phía server của `raw-body` (body đã bị đọc trước đó, stream đã đặt encoding): không phải lỗi
 * của client, nên trả 500 và để caller log to thay vì che thành 400.
 */
const RAW_BODY_SERVER_BUGS: ReadonlySet<string> = new Set([
  'stream.not.readable',
  'stream.encoding.set',
]);

/**
 * Pathname gốc của request, tách đúng như router của Express (`router` dùng `parseurl`). Express cắt mount path
 * khỏi `req.url` khi middleware gắn theo path (spike S1), nên đọc `originalUrl` qua `parseurl.original`. Request
 * dạng absolute-form (`POST http://host/api/auth/x`) có `originalUrl` là URL đầy đủ nhưng router vẫn dispatch
 * theo pathname `/api/auth/x`: so chuỗi thô sẽ để core đọc mất body của prefix đã uỷ quyền (review Task 10).
 * Trả về chữ thường: routing mặc định của Express không phân biệt hoa thường, nên `/API/AUTH/...` vẫn tới
 * handler của `/api/auth/*` và phải được bỏ qua như nhau.
 */
const originalPath = (req: IncomingMessage): string =>
  (parseurl.original(req)?.pathname ?? '').toLowerCase();

/**
 * Parser JSON giới hạn theo STREAM (review B1): `raw-body` đếm byte khi dữ liệu còn đang tới và dừng ngay khi
 * vượt `HTTP_BODY_LIMIT` (unpipe + pause), kể cả body chunked không có Content-Length. Khi đó 413 được trả ngay,
 * rồi socket đóng theo lingering close có giới hạn (`lingerUnreadBody`, ruling S2-R12).
 * Mọi đường trả lời mà KHÔNG đọc body (415 từ header, GET/HEAD có body) cũng đọc bỏ có giới hạn
 * (`lingerIfBodyUnread`, S2-R50): nếu không, Node đọc bỏ phần còn lại không giới hạn và giữ socket.
 * Chỉ nhận body `identity`, `utf-8`, JSON object/array; lỗi luôn đi qua `next(AppError)`.
 * Chủ ý chặt hơn `ContentTypeMiddleware` của SP1: MỌI method có body (không riêng method ghi) mà Content-Type
 * ngoài allowlist đều nhận 415, ở mọi path trừ prefix đã uỷ quyền.
 */
export function jsonBodyParser(
  cfg: ConfigOf<typeof httpConfig>,
  opts: { skipPathPrefix?: string } = {},
): NodeMiddleware {
  const prefix = opts.skipPathPrefix?.toLowerCase();
  const unsupported = (detail: string) =>
    new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, { detail });
  return (req, res, next) => {
    const path = originalPath(req);
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`)))
      return next();
    if (!requestHasBody(req.headers)) return next();
    // GET/HEAD: body không có nghĩa và không ai đọc; vẫn phải đọc bỏ có giới hạn.
    if (METHODS_WITHOUT_BODY.has(req.method ?? '')) {
      lingerIfBodyUnread(req, res, cfg);
      return next();
    }
    const reject = (err: AppError): void => {
      lingerIfBodyUnread(req, res, cfg);
      next(err);
    };
    if (!isAllowedContentType(req.headers, cfg.allowedContentTypes))
      return reject(
        unsupported(
          `Content-Type must be one of: ${cfg.allowedContentTypes.join(', ')}`,
        ),
      );
    if (
      (
        firstHeader(req.headers, 'content-encoding') ?? IDENTITY
      ).toLowerCase() !== IDENTITY
    )
      return reject(unsupported('Content-Encoding must be identity'));
    if ((charsetOf(req.headers) ?? UTF8) !== UTF8)
      return reject(unsupported('charset must be utf-8'));
    getRawBody(
      req,
      {
        limit: cfg.bodyLimit,
        length: firstHeader(req.headers, 'content-length'),
      },
      (err, buf) => {
        if (err) {
          if (err.type === RAW_BODY_TOO_LARGE) {
            lingerUnreadBody(
              req,
              res,
              cfg,
              remainingDeclaredBytes(req, err.received ?? 0),
            );
            return next(
              new AppError(CoreErrors.PAYLOAD_TOO_LARGE, {
                detail: `Body exceeds ${cfg.bodyLimit}`,
              }),
            );
          }
          if (err.type && RAW_BODY_SERVER_BUGS.has(err.type))
            return next(
              new AppError(CoreErrors.INTERNAL_ERROR, { cause: err }),
            );
          // Client huỷ giữa chừng (`request.aborted`), Content-Length sai…: request không đọc được.
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
