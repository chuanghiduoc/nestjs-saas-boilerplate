const warned = new Set<string>();

/**
 * M3: cảnh báo cấu hình phải in đúng MỘT lần mỗi process và ở dạng JSON, không phải text thô của
 * `console.warn`. Nơi gọi hàm này (zod `superRefine` của một `defineConfig`) chạy TRƯỚC khi Nest
 * dựng xong (`validateAllConfigs()` trong `main.api.ts`/`main.worker.ts` gọi trước
 * `NestFactory.create`, `main.migrate.ts` không tạo Nest app nào) và factory cấu hình còn chạy lại
 * lần nữa khi `ConfigModule.forRoot` resolve nó — logger pino thật (DI qua `nestjs-pino`) chưa tồn
 * tại ở thời điểm này. `main.migrate.ts` dùng đúng cách này (`process.stdout.write` một dòng JSON)
 * khi chưa có Nest app; hàm này theo cùng quy ước, ghi ra stderr (mức "warn") thay vì stdout.
 */
export function warnOnce(namespace: string, message: string): void {
  const key = `${namespace}:${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', namespace, msg: message, time: Date.now() })}\n`,
  );
}
