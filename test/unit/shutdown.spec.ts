import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { installShutdown } from '../../src/shutdown.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const TIMEOUT_MS = 1000;

/** Chờ các microtask/then của chuỗi tắt chạy xong. */
const settle = () => new Promise((r) => setImmediate(r));

describe('installShutdown', () => {
  let dispose: (() => void) | undefined;
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let stderr: MockInstance<typeof process.stderr.write>;
  const baseline = new Map(SIGNALS.map((s) => [s, process.listenerCount(s)]));

  beforeEach(() => {
    exit = vi.fn<(code: number) => void>();
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const s of SIGNALS)
      expect(process.listenerCount(s)).toBe(baseline.get(s));
  });

  it('closes the app then exits 0 on SIGTERM, once even if signalled twice', async () => {
    const close = vi.fn(() => Promise.resolve());
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('logs and exits 1 when closing fails', async () => {
    const close = vi.fn(() => Promise.reject(new Error('pool stuck')));
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGINT', 'SIGINT');
    await settle();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/shutdown after SIGINT failed: .*pool stuck/),
    );
  });

  it('forces exit 1 at the deadline when closing hangs', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {}));
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGTERM', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/did not finish within 1000ms/),
    );
  });

  it('does not fire the deadline after a clean shutdown', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => Promise.resolve());
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGTERM', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
