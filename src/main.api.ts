import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppApiModule } from './app-api.module.js';
import { validateAllConfigs } from './core/config/index.js';
import {
  applyHttpDefaults,
  httpConfig,
  setupApiDocs,
} from './core/http/index.js';
import { installShutdown } from './shutdown.js';

export async function bootstrapApi(
  opts: { listen?: boolean } = {},
): Promise<INestApplication> {
  process.env.APP_ROLE = 'api';
  validateAllConfigs();
  // `bodyParser: false`: parser JSON do `applyHttpDefaults` đăng ký (giới hạn theo stream); `/api/auth/*` do
  // identity tự đọc (spec §5.5).
  const app = await NestFactory.create(AppApiModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  applyHttpDefaults(app);
  setupApiDocs(app);
  if (opts.listen === false) {
    await app.init();
    return app;
  }
  const http = httpConfig();
  await app.listen(http.port, http.host);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapApi()
    .then((app) => {
      installShutdown(app);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exit(1);
    });
}
