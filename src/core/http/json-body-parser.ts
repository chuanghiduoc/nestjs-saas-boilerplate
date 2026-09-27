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
const CLOSE = 'close';
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
 * Lingering close sau 413 (ruling S2-R12, thay S2-R9). Response được đánh dấu KHÔNG phải response cuối của socket
 * (`shouldKeepAlive = true`, gỡ `Connection: close` nếu đã đặt): nếu không, khi response `finish` Node tự gọi
 * `socket.destroySoon()` trong lúc client còn đang gửi body; đóng socket khi dữ liệu chưa đọc còn trong buffer nhận
 * làm kernel gửi RST, và client nhận RST có thể mất luôn 413 chưa kịp đọc (ECONNRESET). Node làm vậy cả khi CLIENT
 * gửi `Connection: close` (superagent/supertest mặc định), không riêng khi server đặt header.
 * Sau khi 413 `finish`, đọc và bỏ phần body còn lại cho tới khi, tuỳ điều nào tới trước:
 * - request kết thúc (`end`): client đã xin đóng (`Connection: close`, HTTP/1.0) hoặc server đang draining
 *   (ShutdownCoordinator đặt `Connection: close`) thì đóng êm bằng `end()` (FIN; buffer nhận đã rỗng nên không RST);
 *   còn lại giữ keep-alive như mọi response. Không đóng connection đã quảng bá là keep-alive: client có thể gửi
 *   request kế tiếp đúng lúc FIN tới (ECONNRESET cho request không idempotent). Connection đã drain có parser ở trạng
 *   thái sạch, lúc rảnh bị giới hạn bởi keepAliveTimeout, và mỗi request quá cỡ vẫn chỉ tốn tối đa grace/trần byte;
 * - quá `HTTP_BODY_LIMIT_LINGER_MS`, hoặc số byte bỏ đi vượt `HTTP_BODY_LIMIT_LINGER_BYTES`: huỷ socket (chặn body
 *   chunked vô hạn và client ngừng gửi giữa chừng).
 * Node không có sẵn lingering close có giới hạn (`req._dump()` nội bộ đọc bỏ không giới hạn), và không có package
 * được bảo trì làm việc này, nên tự viết ở đây. Mọi listener/timer được gỡ trên mọi đường: drain xong, hết grace,
 * vượt trần, response/request đóng giữa chừng.
 */
function lingerAfterBodyLimit(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConfigOf<typeof httpConfig>,
): void {
  const closeAfterDrain =
    !res.shouldKeepAlive ||
    String(res.getHeader('Connection') ?? '').toLowerCase() === CLOSE;
  res.removeHeader('Connection');
  res.shouldKeepAlive = true;
  let discarded = 0;
  let timer: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    clearTimeout(timer);
    res.off('finish', onFinish);
    res.off('close', cleanup);
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('close', cleanup);
  };
  const cut = (): void => {
    cleanup();
    req.socket.destroy();
  };
  const onData = (chunk: Buffer): void => {
    discarded += chunk.length;
    if (discarded > cfg.bodyLimitLingerBytes) cut();
  };
  const onEnd = (): void => {
    cleanup();
    if (closeAfterDrain) req.socket.end();
  };
  const onFinish = (): void => {
    // 'close' của response luôn tới sau 'finish': gỡ ngay để nó không huỷ lingering vừa bắt đầu.
    res.off('close', cleanup);
    if (req.complete) return onEnd();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('close', cleanup);
    timer = setTimeout(cut, cfg.bodyLimitLingerMs);
    req.resume();
  };
  res.once('finish', onFinish);
  // Response đóng mà không `finish` (socket đã chết): không còn gì để linger.
  res.once('close', cleanup);
}

/**
 * Parser JSON giới hạn theo STREAM (review B1): `raw-body` đếm byte khi dữ liệu còn đang tới và dừng ngay khi
 * vượt `HTTP_BODY_LIMIT` (unpipe + pause), kể cả body chunked không có Content-Length. Khi đó 413 được trả ngay,
 * rồi socket đóng theo lingering close có giới hạn (`lingerAfterBodyLimit`, ruling S2-R12).
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
            lingerAfterBodyLimit(req, res, cfg);
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
