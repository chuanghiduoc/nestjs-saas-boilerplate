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
 * Số byte body còn phải nhận theo Content-Length đã khai (`received` = byte raw-body đã đọc; 0 khi từ chối ngay từ
 * header). `undefined` khi body chunked: không biết trước độ dài. Node đã từ chối Content-Length không phải số.
 */
const remainingDeclaredBytes = (
  req: IncomingMessage,
  received: number,
): number | undefined => {
  const declared = Number(firstHeader(req.headers, 'content-length'));
  return Number.isSafeInteger(declared) ? declared - received : undefined;
};

/**
 * Lingering close sau 413 (ruling S2-R12, thay S2-R9). Bắt đầu NGAY lúc quyết định 413, trước khi response được ghi:
 * gắn `data` và `resume()` luôn, để body còn lại đi qua bộ đếm của mình. Đợi tới `finish` thì với body chưa ai đọc
 * (Content-Length vượt limit bị từ chối từ header) `resOnFinish` của Node đã gọi `req._dump()` trước: nó gỡ mọi
 * listener `data` và đọc bỏ toàn bộ body không giới hạn, trần byte thành vô hiệu (review FB1).
 * Đọc bỏ cho tới khi, tuỳ điều nào tới trước:
 * - request kết thúc (`end`): chờ 413 `finish` rồi, nếu client xin đóng (`Connection: close`, HTTP/1.0) hoặc
 *   `Connection: close` đã được đặt trước (ShutdownCoordinator lúc draining), đóng êm bằng `end()` (FIN; buffer nhận
 *   đã rỗng nên không RST); còn lại giữ keep-alive như mọi response. Không đóng connection đã quảng bá keep-alive:
 *   client có thể gửi request kế tiếp đúng lúc FIN tới (ECONNRESET cho request không idempotent);
 * - số byte bỏ đi vượt `HTTP_BODY_LIMIT_LINGER_BYTES`: ngừng đọc (Node dừng đọc socket khi buffer của request đầy,
 *   client bị chặn bởi TCP backpressure), và khi 413 đã `finish` thì gửi FIN (`end()`): client đọc 413, thấy server
 *   đóng và tự đóng. Không huỷ ngay: huỷ lúc còn dữ liệu chưa đọc là RST, client chưa kịp đọc 413 sẽ mất nó.
 *   Body Content-Length mà phần còn lại đã khai vượt trần thì chắc chắn tới đây: quyết định đóng ngay lúc 413 (như
 *   client xin đóng), nên 413 không quảng bá keep-alive (ruling S2-R16). Body chunked không biết trước độ dài: nếu
 *   vượt trần sau khi 413 (keep-alive) đã gửi, FIN có thể tới đúng lúc client gửi request kế tiếp trên connection đó
 *   (ECONNRESET). Rủi ro còn lại này được chấp nhận: có giới hạn, hiếm, và chỉ client lỗi hoặc tấn công (body chunked
 *   quá cỡ lớn hơn cả trần) gây ra;
 * - hết `HTTP_BODY_LIMIT_LINGER_MS` tính từ lúc quyết định 413 (kể cả sau khi đã vượt trần mà client không đóng):
 *   huỷ socket, nhưng chỉ sau khi 413 đã `finish`.
 * Khi sẽ đóng, response không được là "response cuối" theo nghĩa của Node: với `Connection: close` (của server HOẶC
 * của client) Node gọi `socket.destroySoon()` lúc `finish` trong khi client còn gửi body; dữ liệu chưa đọc trong
 * buffer nhận làm kernel gửi RST và client mất 413 (ECONNRESET). Nên gỡ header `Connection` (Node khi đó không gửi
 * `Connection`/`Keep-Alive` nào, tức không quảng bá keep-alive) và đặt `shouldKeepAlive = true` chỉ để tắt đường
 * `destroySoon`; việc đóng do hàm này làm sau khi drain. Draining bắt đầu GIỮA lúc linger thì không cần kiểm lại:
 * socket giữ lại sau drain là socket rảnh nên `server.close()` đóng nó (`closeIdleConnections`), còn request kế tiếp
 * trên nó nhận `Connection: close` từ ShutdownCoordinator như mọi request lúc draining.
 * Node không có sẵn lingering close có giới hạn, và không có package được bảo trì làm việc này, nên tự viết ở đây.
 * Mọi listener/timer được gỡ trên mọi đường: drain xong, hết grace, vượt trần, socket đóng giữa chừng (client huỷ
 * sau khi response xong thì `req` không phát `close` nữa, nên nghe `close` của socket).
 */
function lingerAfterBodyLimit(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConfigOf<typeof httpConfig>,
  remainingBytes: number | undefined,
): void {
  const socket = req.socket;
  // S2-R16: phần body còn lại đã khai (Content-Length) vượt trần thì chắc chắn sẽ vượt trần và đóng; quyết định đóng
  // ngay từ đầu để 413 không quảng bá keep-alive.
  const closeAfterDrain =
    !res.shouldKeepAlive ||
    String(res.getHeader('Connection') ?? '').toLowerCase() === CLOSE ||
    (remainingBytes !== undefined && remainingBytes > cfg.bodyLimitLingerBytes);
  if (closeAfterDrain) {
    res.removeHeader('Connection');
    res.shouldKeepAlive = true;
  }
  let discarded = 0;
  let drained = req.readableEnded;
  let answered = false;
  let capped = false;
  let expired = false;
  const cleanup = (): void => {
    clearTimeout(timer);
    req.off('data', onData);
    req.off('end', onEnd);
    res.off('finish', onFinish);
    socket.off('close', cleanup);
  };
  /** Chạy sau mỗi lần đổi trạng thái; chỉ hành động khi 413 đã gửi xong. */
  const settle = (): void => {
    if (!answered) return;
    if (expired) {
      cleanup();
      socket.destroy();
    } else if (drained) {
      cleanup();
      if (closeAfterDrain) socket.end();
    } else if (capped && !socket.writableEnded) {
      // Giữ timer và listener `close`: client không đóng thì hết grace sẽ huỷ.
      socket.end();
    }
  };
  const onData = (chunk: Buffer): void => {
    discarded += chunk.length;
    if (discarded <= cfg.bodyLimitLingerBytes) return;
    capped = true;
    req.off('data', onData);
    req.pause();
    settle();
  };
  const onEnd = (): void => {
    drained = true;
    clearTimeout(timer);
    settle();
  };
  const onFinish = (): void => {
    answered = true;
    settle();
  };
  const onExpired = (): void => {
    expired = true;
    req.off('data', onData);
    req.pause();
    settle();
  };
  const timer = drained
    ? undefined
    : setTimeout(onExpired, cfg.bodyLimitLingerMs);
  req.on('data', onData);
  req.once('end', onEnd);
  res.once('finish', onFinish);
  socket.once('close', cleanup);
  req.resume();
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
            lingerAfterBodyLimit(
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
