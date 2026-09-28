/**
 * Nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js`, trước mọi module của
 * app. Không đăng ký signal handler: việc tắt (và flush telemetry) do `installShutdown` điều phối.
 */
import { register } from 'import-in-the-middle/register-hooks.mjs';
import { otelConfig } from './core/observability/otel.config.js';
import { startTelemetry } from './core/observability/telemetry-lifecycle.js';

const cfg = otelConfig();
if (cfg.enabled) {
  // App là ESM: auto-instrumentation chỉ patch được module `import` khi hook loader của
  // import-in-the-middle đã đăng ký trước khi entrypoint được nạp. Dùng hook đồng bộ, chạy trên
  // thread của app (`module.registerHooks`), không dùng `module.register` (loader chạy thread riêng,
  // mỗi module được resolve/load tốn một vòng IPC: ~4k module của app làm startup chậm ~1 s, đo ở
  // ADR 0013). `include` giới hạn loader chỉ bọc các module mà instrumentation thật sự hook, như kênh
  // message của cách cũ. `register` ném lỗi rõ ràng nếu bản Node không hỗ trợ hook đồng bộ.
  register({ include: startTelemetry(cfg) });
}
