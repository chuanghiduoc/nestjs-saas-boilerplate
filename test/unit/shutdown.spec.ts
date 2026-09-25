import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { installShutdown } from '../../src/shutdown.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const TIMEOUT_MS = 1000;
const PROBE = 'test/fixtures/shutdown-probe.ts';
/** Giới hạn cho process con (nạp TS qua swc + OTel SDK), rộng hơn nhiều so với hạn chót 300ms của probe. */
const CHILD_LIMIT_MS = 30_000;
/**
 * Test sinh process con phải chờ được hết `CHILD_LIMIT_MS`: dưới tải của cả bộ unit chạy song
 * song, nạp swc + OTel có thể quá 5s mặc định của vitest dù probe vẫn đúng (flake, không phải lỗi).
 */
const CHILD_TEST_TIMEOUT_MS = CHILD_LIMIT_MS + 5_000;

const runProbe = (mode: 'hang' | 'clean') =>
  spawnSync(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', PROBE, mode],
    { encoding: 'utf8', timeout: CHILD_LIMIT_MS },
  );

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

  it('closes the app then exits 0 on SIGTERM, once even if signalled again', async () => {
    const close = vi.fn(() => Promise.resolve());
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps its handlers during shutdown so a repeated SIGTERM is ignored, not fatal', async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    dispose = installShutdown({ close }, { timeoutMs: TIMEOUT_MS, exit });
    process.emit('SIGTERM', 'SIGTERM');
    // Còn listener thì Node không chạy hành động mặc định (kết thúc process) cho signal lặp lại.
    expect(process.listenerCount('SIGTERM')).toBe(
      (baseline.get('SIGTERM') ?? 0) + 1,
    );
    process.emit('SIGTERM', 'SIGTERM');
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/SIGTERM received while shutting down; ignored/),
    );
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

  it(
    'the deadline keeps a hung process alive until it logs and exits 1 (real event loop)',
    { timeout: CHILD_TEST_TIMEOUT_MS },
    () => {
      const r = runProbe('hang');
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/did not finish within 300ms; forcing exit/);
    },
  );

  it(
    'a clean shutdown exits 0 without waiting for the deadline (real event loop)',
    { timeout: CHILD_TEST_TIMEOUT_MS },
    () => {
      const r = runProbe('clean');
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/forcing exit/);
    },
  );
});
