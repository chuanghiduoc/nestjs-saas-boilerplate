// DIAGNOSTIC ONLY (fix/nightly-smoke investigation) — removed before the fix lands.
import dc from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

const t = (): string => `${new Date().toISOString()} ${process.hrtime.bigint() / 1_000_000n}`;
const log = (m: string): void => {
  process.stderr.write(`[ka] ${t()} ${m}\n`);
};

const seen = new WeakSet<Socket>();
dc.subscribe('undici:client:connected', (msg) => {
  const { socket } = msg as { socket: Socket };
  const p = socket.localPort;
  log(`connected local=${p}`);
  if (seen.has(socket)) return;
  seen.add(socket);
  socket.on('end', () => log(`end(FIN processed) local=${p}`));
  socket.on('close', () => log(`close local=${p}`));
});
dc.subscribe('undici:client:sendHeaders', (msg) => {
  const { request, socket } = msg as {
    request: { method: string; path: string };
    socket: Socket;
  };
  log(`send local=${socket.localPort} ${request.method} ${request.path}`);
});
dc.subscribe('undici:request:headers', (msg) => {
  const { response } = msg as { response: { statusCode: number; headers: Buffer[] } };
  const h = response.headers.map(String);
  const i = h.findIndex((x) => /^(keep-alive|connection)$/i.test(x));
  log(`response ${response.statusCode} ${i >= 0 ? `${h[i]}=${h[i + 1]}` : ''} ${h
    .map((x, j) => (/^keep-alive$/i.test(x) ? `ka=${h[j + 1]}` : ''))
    .join('')}`);
});
dc.subscribe('undici:request:error', (msg) => {
  const { error } = msg as { error: Error };
  log(`request error ${error.message}`);
});

export function traceSync<T>(label: string, fn: () => T): T {
  log(`sync begin ${label}`);
  try {
    return fn();
  } finally {
    log(`sync end ${label}`);
  }
}
