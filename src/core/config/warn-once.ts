import pino from 'pino';

const warned = new Set<string>();
/** N8: pino ghi `level` dạng số (10/20/.../60), không phải chuỗi; lấy từ chính pino, không hard-code 40. */
const PINO_WARN_LEVEL = pino.levels.values.warn;

/**
 * M3: cảnh báo cấu hình phải in đúng MỘT lần mỗi process và ở dạng JSON, không phải text thô của
 * `console.warn`. Nơi gọi hàm này (zod `superRefine` của một `defineConfig`) chạy TRƯỚC khi Nest
 * dựng xong (`validateAllConfigs()` trong `main.api.ts`/`main.worker.ts` gọi trước
 * `NestFactory.create`, `main.migrate.ts` không tạo Nest app nào) và factory cấu hình còn chạy lại
 * lần nữa khi `ConfigModule.forRoot` resolve nó — logger pino thật (DI qua `nestjs-pino`) chưa tồn
 * tại ở thời điểm này. `main.migrate.ts` dùng đúng cách này (`process.stdout.write` một dòng JSON)
 * khi chưa có Nest app; hàm này theo cùng quy ước, ghi ra stderr (mức "warn") thay vì stdout.
 *
 * N8: `level` ghi dạng SỐ (`pino.levels.values.warn` = 40), giống mọi dòng log pino thật — pipeline lọc theo
 * `level >= 40` (chuẩn pino) không âm thầm bỏ qua dòng này vì nó từng là `level: "warn"` (chuỗi).
 */
export function warnOnce(namespace: string, message: string): void {
  const key = `${namespace}:${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(
    `${JSON.stringify({ level: PINO_WARN_LEVEL, namespace, msg: message, time: Date.now() })}\n`,
  );
}
