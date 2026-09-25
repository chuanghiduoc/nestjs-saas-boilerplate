/**
 * Chạy trong process con (test/unit/shutdown.spec.ts): kiểm tra hành vi thật của event loop,
 * điều mà fake timers trong process test không thấy được. Tham số: `hang` | `clean`.
 */
import { installShutdown } from '../../src/shutdown.js';

const PROBE_TIMEOUT_MS = 300;
const CLEAN_TIMEOUT_MS = 60_000;

const mode = process.argv[2];
if (mode === 'hang')
  // Promise không bao giờ settle và không giữ handle nào: chỉ timer hạn chót còn giữ process.
  installShutdown(
    { close: () => new Promise<void>(() => {}) },
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
else if (mode === 'clean')
  installShutdown(
    { close: () => Promise.resolve() },
    { timeoutMs: CLEAN_TIMEOUT_MS },
  );
else throw new Error(`unknown probe mode "${String(mode)}"`);
process.emit('SIGTERM', 'SIGTERM');
