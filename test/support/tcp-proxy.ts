import net from 'node:net';

export type TcpProxy = {
  /**
   * `blackhole = true`: giữ socket mở nhưng bỏ mọi byte (mạng mất gói, không RST).
   * `commit`: số phận của câu COMMIT kế tiếp trên mỗi connection (xem `CommitFate`).
   */
  state: { blackhole: boolean; commit: CommitFate };
  port: number;
  /** Đóng mọi connection đang mở mà không gửi gì trước (như mạng/PgBouncer reset); proxy vẫn nhận connection mới. */
  sever(): void;
  close(): Promise<void>;
};

/**
 * - `pass`: bình thường.
 * - `pooler-crash`: như PgBouncer khi connection server chết lúc COMMIT đang bay — COMMIT tới server (commit bền), câu trả
 *   lời bị bỏ, client nhận ErrorResponse `08P01 server conn crashed?` (`poolerCrash`) rồi socket đóng.
 * - `blackhole`: COMMIT KHÔNG tới server và connection đó thành blackhole từ đây (client hết `query_timeout`; khi client
 *   huỷ socket, server rollback).
 */
export type CommitFate = 'pass' | 'pooler-crash' | 'blackhole';

/** Message `Query` (simple protocol) hoặc `Parse` (extended) mang câu `COMMIT`. */
const COMMIT_MESSAGE = /^[QP][\s\S]{4}[\s\S]*\bcommit\b/i;

/**
 * ErrorResponse đúng như PgBouncer `send_pooler_error(client, false, NULL, true, "server conn crashed?")` (proto.c): các
 * trường `S` FATAL, `C` 08P01 (mặc định khi sqlstate NULL), `M`, rồi byte 0 kết thúc.
 */
function poolerCrash(): Buffer {
  const fields = Buffer.from(
    'SFATAL\0C08P01\0Mserver conn crashed?\0\0',
    'latin1',
  );
  const header = Buffer.alloc(5);
  header.write('E', 0, 'latin1');
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

/**
 * Proxy TCP loopback tới `host:port`, giả lập lỗi mạng mà Postgres/PgBouncer không tạo được theo ý:
 * blackhole (query treo, không RST), reset giữa chừng (socket đóng khi query còn chạy, không có
 * ErrorResponse trước: pg phát `'error'` đồng bộ trên client), và số phận của COMMIT (`CommitFate`, final review I1/M3).
 */
export async function startTcpProxy(
  host: string,
  port: number,
): Promise<TcpProxy> {
  const state: TcpProxy['state'] = { blackhole: false, commit: 'pass' };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    let commitInFlight = false;
    let crashed = false;
    let hole = false;
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('close', close);
      s.on('error', close);
    }
    client.on('data', (d: Buffer) => {
      if (state.blackhole || hole) return;
      const fate = COMMIT_MESSAGE.test(d.toString('latin1'))
        ? state.commit
        : 'pass';
      switch (fate) {
        case 'pass':
          break;
        case 'blackhole':
          hole = true;
          return;
        case 'pooler-crash':
          commitInFlight = true;
          break;
        default: {
          const unknown: never = fate;
          throw new Error(`unknown commit fate ${String(unknown)}`);
        }
      }
      upstream.write(d);
    });
    upstream.on('data', (d: Buffer) => {
      if (state.blackhole || hole) return;
      if (!commitInFlight) {
        client.write(d);
        return;
      }
      if (crashed) return;
      crashed = true;
      // Server đã trả lời COMMIT (commit đã bền hoặc chưa, client không bao giờ biết): thay bằng lỗi của pooler, rồi
      // đóng cả hai phía khi lỗi đã ghi xong (destroy sớm hơn có thể bỏ mất byte chưa flush).
      client.end(poolerCrash(), close);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('proxy did not bind a TCP port');
  const sever = () => {
    for (const s of sockets) s.destroy();
  };
  return {
    state,
    port: address.port,
    sever,
    close: () =>
      new Promise<void>((resolve) => {
        sever();
        server.close(() => resolve());
      }),
  };
}
