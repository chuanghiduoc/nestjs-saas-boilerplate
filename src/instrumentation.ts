/**
 * Nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js`, trước mọi module của
 * app. Không đăng ký signal handler: việc tắt (và flush telemetry) do `installShutdown` điều phối.
 */
import { createAddHookMessageChannel } from 'import-in-the-middle';
import { register } from 'node:module';
import { otelConfig } from './core/observability/otel.config.js';
import { startTelemetry } from './core/observability/telemetry-lifecycle.js';

const cfg = otelConfig();
if (cfg.enabled) {
  // App là ESM: auto-instrumentation chỉ patch được module `import` khi hook loader của
  // import-in-the-middle đã đăng ký trước khi entrypoint được nạp. Kênh message báo cho loader
  // chỉ bọc các module mà instrumentation thật sự hook (không bọc mọi module của app), theo
  // README của import-in-the-middle. Chỉ đăng ký khi bật OTel.
  const { registerOptions, waitForAllMessagesAcknowledged } =
    createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
  startTelemetry(cfg);
  // Loader phải nhận đủ danh sách module cần hook trước khi entrypoint bắt đầu import.
  await waitForAllMessagesAcknowledged();
}
