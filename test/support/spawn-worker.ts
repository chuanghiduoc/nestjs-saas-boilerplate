import { fork, type ChildProcess } from 'node:child_process';

const TS_LOADER_ARGS = ['--import', '@swc-node/register/esm-register'];
const WORKER_ENTRY = 'test/support/worker-entry.ts';
const POLL_MS = 50;

export type WorkerMsg = { ready?: boolean; started?: string; done?: string };
/** Windows không giao signal POSIX cho handler của Node; process cha nhờ entry phát lại qua IPC. */
export type SignalRelay = { signal: 'SIGTERM' };

const isRecord = (m: unknown): m is Record<string, unknown> =>
  typeof m === 'object' && m !== null;
const isWorkerMsg = (m: unknown): m is WorkerMsg =>
  isRecord(m) && ('ready' in m || 'started' in m || 'done' in m);
export const isSignalRelay = (m: unknown): m is SignalRelay =>
  isRecord(m) && m.signal === 'SIGTERM';

/** Chạy test/support/worker-entry.ts trong process thật; resolve khi worker báo `ready`. */
export function startWorker(
  env: Record<string, string>,
): Promise<{ child: ChildProcess; messages: WorkerMsg[] }> {
  const child = fork(WORKER_ENTRY, [], {
    execArgv: TS_LOADER_ARGS,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const messages: WorkerMsg[] = [];
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) =>
      reject(new Error(`worker exited early with ${code}`));
    child.once('exit', onExit);
    child.on('message', (m: unknown) => {
      if (!isWorkerMsg(m)) return;
      messages.push(m);
      if (m.ready) {
        child.off('exit', onExit);
        resolve({ child, messages });
      }
    });
  });
}

/**
 * Gửi SIGTERM: signal thật trên Linux/macOS (CI); trên Windows gửi qua IPC để entry gọi
 * `process.emit('SIGTERM')` (xem worker-entry.ts). Cả hai đều chạy handler của `installShutdown`.
 */
export function sendSigterm(child: ChildProcess): void {
  if (process.platform === 'win32') {
    const relay: SignalRelay = { signal: 'SIGTERM' };
    child.send(relay);
  } else child.kill('SIGTERM');
}

/** Dọn process con còn sống (test lỗi giữa chừng) để không rò process. */
export function killIfAlive(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
}

export const waitForMessage = (
  messages: WorkerMsg[],
  pred: (m: WorkerMsg) => boolean,
  ms: number,
) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (messages.some(pred)) return resolve();
      if (Date.now() - started > ms)
        return reject(new Error('timeout waiting for worker message'));
      setTimeout(tick, POLL_MS);
    };
    tick();
  });

export const exitCode = (child: ChildProcess) =>
  new Promise<number | null>((r) => child.once('exit', r));
