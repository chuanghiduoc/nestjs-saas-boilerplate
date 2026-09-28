import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { expect } from 'vitest';

/** Upload HTTP/1.1 qua socket thô, để thấy đúng lỗi TCP (ECONNRESET/EPIPE) mà client HTTP thường che đi. */
export const CRLF = '\r\n';
const HEAD_END = `${CRLF}${CRLF}`;
const UPLOAD_DEADLINE_MS = 15_000;
const CHUNK_BYTES = 16 * 1024;
const CONTENT_LENGTH = /^content-length:\s*(\d+)$/im;

export type Upload = {
  raw: string;
  error: string | undefined;
  /** ms từ byte đầu tiên của response tới lúc socket đóng; -1 khi không nhận được byte nào. */
  closeAfterResponseMs: number;
};

/**
 * `keep-alive`: client không gửi `Connection`, và tự `end()` khi đã nhận đủ response (server giữ connection).
 * `close`: client gửi `Connection: close` và chờ SERVER đóng socket.
 * `server-closes`: không gửi `Connection`, chờ server đóng (hết grace, vượt trần, hoặc server đang draining).
 */
export type UploadMode = 'keep-alive' | 'close' | 'server-closes';

/** Response đầy đủ (head + đủ `Content-Length` byte thân) đã có trong `raw` chưa. */
const isAnswered = (raw: string): boolean => {
  const at = raw.indexOf(HEAD_END);
  if (at < 0) return false;
  const len = CONTENT_LENGTH.exec(raw.slice(0, at))?.[1];
  return (
    len !== undefined &&
    Buffer.byteLength(raw.slice(at + HEAD_END.length)) >= Number(len)
  );
};

export const chunkFrame = (chunk: string): string =>
  `${chunk.length.toString(16)}${CRLF}${chunk}${CRLF}`;

/**
 * Gửi header rồi gọi `send` để ghi body, và chờ socket đóng. Mọi lỗi socket được ghi lại thay vì ném: ở đây lỗi socket
 * là dữ liệu cần kiểm (ECONNRESET chính là lỗi ruling S2-R12 sửa).
 */
export async function upload(
  port: number,
  headers: string,
  send: (sock: Socket) => void,
  path: string,
  mode: UploadMode,
): Promise<Upload> {
  const sock = connect(port, '127.0.0.1');
  const received: Buffer[] = [];
  let error: string | undefined;
  let firstByteAt = 0;
  sock.on('data', (c: Buffer) => {
    firstByteAt ||= Date.now();
    received.push(c);
    // `end()` xếp sau mọi write đang chờ: body vẫn được gửi hết trước FIN.
    if (mode === 'keep-alive' && isAnswered(Buffer.concat(received).toString()))
      sock.end();
  });
  sock.on('error', (e: NodeJS.ErrnoException) => {
    error = e.code ?? e.message;
  });
  await once(sock, 'connect');
  const deadline = setTimeout(() => {
    error = 'client deadline: socket never closed';
    sock.destroy();
  }, UPLOAD_DEADLINE_MS);
  const connection = mode === 'close' ? `Connection: close${CRLF}` : '';
  sock.write(
    `POST ${path} HTTP/1.1${CRLF}Host: t${CRLF}Content-Type: application/json${CRLF}${connection}${headers}${CRLF}`,
  );
  send(sock);
  // Không dùng `events.once`: nó reject khi có 'error'.
  await new Promise<void>((r) => sock.once('close', () => r()));
  clearTimeout(deadline);
  return {
    raw: Buffer.concat(received).toString('utf8'),
    error,
    closeAfterResponseMs: firstByteAt ? Date.now() - firstByteAt : -1,
  };
}

/** Body có Content-Length, ghi hết một lần. */
export const contentLengthUpload = (
  port: number,
  bytes: number,
  path: string,
  mode: UploadMode,
): Promise<Upload> =>
  upload(
    port,
    `Content-Length: ${bytes}${CRLF}`,
    (s) => s.write(Buffer.alloc(bytes, 'x')),
    path,
    mode,
  );

/** Body chunked hữu hạn (kết thúc bằng chunk 0), ghi liền. */
export const chunkedUpload = (
  port: number,
  bytes: number,
  path: string,
  mode: UploadMode,
): Promise<Upload> =>
  upload(
    port,
    `Transfer-Encoding: chunked${CRLF}`,
    (s) => {
      const frame = chunkFrame('x'.repeat(CHUNK_BYTES));
      for (let sent = 0; sent < bytes; sent += CHUNK_BYTES) s.write(frame);
      s.write(`0${CRLF}${CRLF}`);
    },
    path,
    mode,
  );

/** Upload hữu hạn quá cỡ chạy song song: với MỖI cách đóng connection, `counts.contentLength` + `counts.chunked` upload. */
export const oversizedUploadMix = (
  port: number,
  bytes: number,
  path: string,
  counts: { contentLength: number; chunked: number },
): Promise<Upload>[] =>
  (['keep-alive', 'close'] as const).flatMap((mode) => [
    ...Array.from({ length: counts.contentLength }, () =>
      contentLengthUpload(port, bytes, path, mode),
    ),
    ...Array.from({ length: counts.chunked }, () =>
      chunkedUpload(port, bytes, path, mode),
    ),
  ]);

/** Response đầy đủ, không lỗi socket: status 413, problem+json, thân đúng Content-Length. */
export function expectFull413(u: Upload): void {
  expect(u.error).toBeUndefined();
  const [head = '', body = ''] = u.raw.split(HEAD_END);
  const lines = head.toLowerCase().split(CRLF);
  expect(lines[0]).toBe('http/1.1 413 payload too large');
  expect(lines).not.toContain('connection: close');
  expect(lines).toContain(
    'content-type: application/problem+json; charset=utf-8',
  );
  expect(lines).toContain(`content-length: ${Buffer.byteLength(body)}`);
  expect(JSON.parse(body)).toMatchObject({
    status: 413,
    code: 'payload_too_large',
  });
}
