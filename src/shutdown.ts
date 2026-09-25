import { appConfig } from './core/config/index.js';
import { shutdownTelemetry } from './core/observability/telemetry-lifecycle.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type ShutdownOptions = {
  /** Mặc định `APP_SHUTDOWN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Chỉ để test thay `process.exit`. */
  exit?: (code: number) => void;
};

const describeError = (err: unknown) =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

/**
 * Tắt êm: đóng app (Nest chạy hook theo thứ tự: draining → đóng HTTP → worker/relay/pool), rồi
 * flush telemetry, rồi thoát. Quá `timeoutMs` (handler bỏ qua abort nên WorkerHost bỏ worker,
 * `OutboxRelay.stop()` chờ lô treo, collector không phản hồi…) thì log lỗi và exit 1, để process
 * luôn tự thoát trước khi orchestrator SIGKILL.
 *
 * - Handler đăng ký bằng `process.on` (không `once`) và giữ nguyên tới khi thoát: gỡ handler thì
 *   signal thứ hai (SIGTERM gửi lại, Ctrl+C lần hai) chạy hành động mặc định và giết process
 *   giữa lúc drain. Signal lặp lại được log rồi bỏ qua.
 * - Timer hạn chót KHÔNG `unref`: nếu `close()` treo trên một promise không còn giữ handle nào,
 *   event loop rỗng sẽ làm process tự thoát 0 trong im lặng; timer ref giữ process sống tới hạn
 *   chót để lỗi được log và exit 1. Đường bình thường xoá timer trước khi thoát.
 * Trả về hàm gỡ handler (cho test; process thật không cần gọi).
 */
export function installShutdown(
  app: { close(): Promise<void> },
  opts: ShutdownOptions = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? appConfig().shutdownTimeoutMs;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let closing = false;
  let deadline: NodeJS.Timeout | undefined;

  const onSignal = (signal: NodeJS.Signals) => {
    if (closing) {
      process.stderr.write(`${signal} received while shutting down; ignored
`);
      return;
    }
    closing = true;
    deadline = setTimeout(() => {
      process.stderr.write(
        `shutdown after ${signal} did not finish within ${timeoutMs}ms; forcing exit\n`,
      );
      exit(1);
    }, timeoutMs);
    app
      .close()
      .then(shutdownTelemetry)
      .then(
        () => {
          clearTimeout(deadline);
          exit(0);
        },
        (err: unknown) => {
          clearTimeout(deadline);
          process.stderr.write(
            `shutdown after ${signal} failed: ${describeError(err)}\n`,
          );
          exit(1);
        },
      );
  };

  const handlers = SIGNALS.map((s) => {
    const handler = () => onSignal(s);
    process.on(s, handler);
    return [s, handler] as const;
  });
  return () => {
    clearTimeout(deadline);
    for (const [s, handler] of handlers) process.removeListener(s, handler);
  };
}
