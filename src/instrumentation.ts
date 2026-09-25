/**
 * Nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js`, trước mọi module của
 * app. Không đăng ký signal handler: việc tắt (và flush telemetry) do `installShutdown` điều phối.
 */
import { register } from 'node:module';
import { otelConfig } from './core/observability/otel.config.js';
import { startTelemetry } from './core/observability/telemetry-lifecycle.js';

const cfg = otelConfig();
if (cfg.enabled) {
  // App là ESM: auto-instrumentation chỉ patch được module `import` khi hook loader của
  // import-in-the-middle đã đăng ký trước khi entrypoint được nạp. Chỉ đăng ký khi bật OTel
  // (hook bọc mọi module được import).
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}
startTelemetry(cfg);
