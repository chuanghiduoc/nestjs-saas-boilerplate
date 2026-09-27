import net from 'node:net';

export type TcpProxy = {
  /** `blackhole = true`: giữ socket mở nhưng bỏ mọi byte (mạng mất gói, không RST). */
  state: { blackhole: boolean };
  port: number;
  /** Đóng mọi connection đang mở mà không gửi gì trước (như mạng/PgBouncer reset); proxy vẫn nhận connection mới. */
  sever(): void;
  close(): Promise<void>;
};

/**
 * Proxy TCP loopback tới `host:port`, giả lập lỗi mạng mà Postgres/PgBouncer không tạo được theo ý:
 * blackhole (query treo, không RST) và reset giữa chừng (socket đóng khi query còn chạy, không có
 * ErrorResponse trước: pg phát `'error'` đồng bộ trên client).
 */
export async function startTcpProxy(
  host: string,
  port: number,
): Promise<TcpProxy> {
  const state = { blackhole: false };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
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
    client.on('data', (d) => void (state.blackhole || upstream.write(d)));
    upstream.on('data', (d) => void (state.blackhole || client.write(d)));
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
