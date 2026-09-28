/**
 * API trong process con thật (test/support/app-process.ts): đúng đường khởi động của production (`bootstrapApi`:
 * `AppApiModule` với `LoggingModule` — nestjs-pino + pino-http, redaction và serializer của SP1 — rồi `useLogger`),
 * để test đọc được đúng dòng JSON mà pino ghi ra fd 1. Báo `{ ready, port }` qua IPC khi đã listen.
 *
 * Windows không giao SIGTERM cho handler của Node: process cha gửi `{ signal: 'SIGTERM' }` qua IPC (như worker-entry).
 */
import { Server } from 'node:http';
import { bootstrapApi } from '../../src/main.api.js';
import { installShutdown } from '../../src/shutdown.js';
import { isSignalRelay } from './spawn-worker.js';

const app = await bootstrapApi();
installShutdown(app);
process.on('message', (m: unknown) => {
  if (isSignalRelay(m)) process.emit(m.signal, m.signal);
});
const server: unknown = app.getHttpServer();
const address = server instanceof Server ? server.address() : undefined;
if (typeof address !== 'object' || address === null)
  throw new Error('api-entry: the HTTP server is not listening on a TCP port');
process.send?.({ ready: true, port: address.port });
