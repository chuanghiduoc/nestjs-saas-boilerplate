import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ReceivedRequest = {
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
};
export type ReceiverResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
};
export type WebhookReceiver = {
  port: number;
  url(path?: string): string;
  requests: ReceivedRequest[];
  /** Số kết nối TCP đã nhận (W-22: chặn ở lookup thì không có kết nối nào). */
  connections(): number;
  /** Hàng đợi response; hết hàng thì 204. */
  respondWith(...r: ReceiverResponse[]): void;
  /** Giữ mọi request mới (không trả lời) tới khi `release()`: ép xen kẽ "đang gửi" (R6-9, R6-11). */
  hold(): void;
  release(): void;
  waitFor(n: number, timeoutMs?: number): Promise<ReceivedRequest[]>;
  close(): Promise<void>;
};
const POLL_MS = 20;
const DEFAULT_WAIT_MS = 10_000;

/** Receiver HTTP trên 127.0.0.1, cổng tự chọn; chỉ ở test/. */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: ReceivedRequest[] = [];
  const queue: ReceiverResponse[] = [];
  let held: (() => void)[] | undefined;
  let connections = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: Date.now(),
      });
      const reply = () => {
        const r = queue.shift() ?? { status: 204 };
        setTimeout(() => {
          res.writeHead(r.status, r.headers);
          res.end(r.body);
        }, r.delayMs ?? 0);
      };
      if (held) held.push(reply);
      else reply();
    });
  });
  server.on('connection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    requests,
    connections: () => connections,
    respondWith: (...r) => queue.push(...r),
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = undefined;
      for (const reply of waiting) reply();
    },
    waitFor: async (n, timeoutMs = DEFAULT_WAIT_MS) => {
      const until = Date.now() + timeoutMs;
      while (requests.length < n) {
        if (Date.now() > until)
          throw new Error(
            `receiver: ${requests.length} of ${n} requests within ${timeoutMs} ms`,
          );
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return requests.slice(0, n);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
