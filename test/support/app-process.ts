import { fork, type ChildProcess } from 'node:child_process';
import { killIfAlive, sendSigterm } from './spawn-worker.js';

const TS_LOADER_ARGS = ['--import', '@swc-node/register/esm-register'];
/** Boot gồm nạp TS qua swc, kết nối DB/Redis, tạo worker BullMQ; rộng hơn nhiều so với thực tế. */
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

export type AppProcess = {
  child: ChildProcess;
  /** Mọi byte process ghi ra stdout + stderr (pino ghi JSON thẳng vào fd 1). */
  output: () => string;
  /** Port HTTP nếu entry báo `{ ready, port }` (api-entry). */
  port?: number;
};

const isReady = (m: unknown): m is { ready: true; port?: unknown } =>
  typeof m === 'object' && m !== null && 'ready' in m && m.ready === true;

/**
 * Chạy một entry TS trong process con thật với stdout/stderr PIPE (khác `startWorker`: `inherit`), để test đọc được
 * đúng output của pino. Không `ready` trong hạn, fork lỗi hay thoát sớm thì kill con rồi reject.
 */
export function startAppProcess(
  entry: string,
  env: Record<string, string>,
): Promise<AppProcess> {
  const child = fork(entry, [], {
    execArgv: TS_LOADER_ARGS,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const chunks: string[] = [];
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  const output = () => chunks.join('');
  return new Promise((resolve, reject) => {
    const fail = (err: Error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      killIfAlive(child);
      reject(new Error(`${err.message}\n--- child output ---\n${output()}`));
    };
    const onExit = (code: number | null) =>
      fail(new Error(`${entry} exited early with ${code}`));
    const timer = setTimeout(
      () => fail(new Error(`${entry} not ready within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    );
    child.once('exit', onExit);
    child.once('error', fail);
    child.on('message', (m: unknown) => {
      if (!isReady(m)) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', fail);
      // Sau khi sẵn sàng vẫn giữ một listener `error` (vd. `send` trên kênh IPC đã đóng lúc dừng trên Windows): ghi
      // vào output thay vì để thành sự kiện `error` không ai bắt làm hỏng cả process test (N4).
      child.on('error', (err: Error) =>
        chunks.push(`[app-process error] ${err.message}\n`),
      );
      resolve({
        child,
        output,
        ...(typeof m.port === 'number' ? { port: m.port } : {}),
      });
    });
  });
}

/** SIGTERM (graceful: `installShutdown` xả log), chờ thoát; quá hạn thì SIGKILL. */
export async function stopAppProcess(p: AppProcess | undefined): Promise<void> {
  if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return;
  const exited = new Promise<void>((r) => p.child.once('exit', () => r()));
  sendSigterm(p.child);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((r) => {
    timer = setTimeout(r, STOP_TIMEOUT_MS);
  });
  await Promise.race([exited, timeout]);
  clearTimeout(timer);
  killIfAlive(p.child);
}
