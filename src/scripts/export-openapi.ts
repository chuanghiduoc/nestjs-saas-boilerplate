import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppApiModule } from '../app-api.module.js';
import { buildOpenApi } from '../core/http/openapi.js';

const OUTPUT = 'openapi.json';
const TITLE = 'NestJS SaaS Boilerplate';

/**
 * Sinh `openapi.json` (commit vào repo để CI so sánh bằng oasdiff). `preview: true` dựng đồ thị module
 * mà không khởi tạo provider (không chạy factory config, không kết nối DB/Redis), nên không cần env.
 */
async function main(): Promise<void> {
  process.env.APP_ROLE = 'api';
  const app = await NestFactory.create(AppApiModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  writeFileSync(
    OUTPUT,
    `${JSON.stringify(buildOpenApi(app, TITLE), null, 2)}\n`,
  );
  await app.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
