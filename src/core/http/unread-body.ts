import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf } from '../config/index.js';
import { firstHeader, requestHasBody } from './content-type.js';
import type { httpConfig } from './http.config.js';

const CLOSE = 'close';
/** Request đã được đánh dấu lingering: gọi lần hai (vd. parser rồi mount) không gắn listener/timer lần nữa. */
const lingering = new WeakSet<IncomingMessage>();

/**
 * Số byte body còn phải nhận theo Content-Length đã khai (`received` = byte raw-body đã đọc; 0 khi từ chối ngay từ
 * header). `undefined` khi body chunked: không biết trước độ dài. Node đã từ chối Content-Length không phải số.
 */
export const remainingDeclaredBytes = (
  req: IncomingMessage,
  received: number,
): number | undefined => {
  const declared = Number(firstHeader(req.headers, 'content-length'));
  return Number.isSafeInteger(declared) ? declared - received : undefined;
};

/**
 * Lingering close có giới hạn cho MỌI response gửi khi body còn chưa đọc hết (ruling S2-R12, thay S2-R9; S2-R50 tách
 * khỏi parser để dùng chung: 413, 415, GET/HEAD có body, từ chối sớm của mount `/api/auth/*`). Bắt đầu NGAY lúc quyết định 413, trước khi response được ghi:
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
export function lingerUnreadBody(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConfigOf<typeof httpConfig>,
  remainingBytes: number | undefined,
): void {
  if (lingering.has(req)) return;
  lingering.add(req);
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
 * Điểm vào dùng chung (S2-R50): gọi NGAY TRƯỚC khi ghi một response mà body của request chưa được đọc (từ chối từ
 * header: 415, 400 đa credential, 403 CSRF; GET/HEAD có body mà không ai đọc). Không có body, hoặc body đã đọc hết,
 * thì không làm gì: Node tự xử lý như mọi response. Còn lại: đọc bỏ có giới hạn byte/thời gian như sau 413, để
 * client đọc được trọn response (không RST) mà server không nhận body vô hạn hay giữ socket tới `requestTimeout`.
 */
export function lingerIfBodyUnread(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConfigOf<typeof httpConfig>,
): void {
  if (!requestHasBody(req.headers) || req.readableEnded) return;
  lingerUnreadBody(req, res, cfg, remainingDeclaredBytes(req, 0));
}
