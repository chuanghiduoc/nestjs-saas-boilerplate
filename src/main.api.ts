import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppApiModule } from './app-api.module.js';
import { validateAllConfigs } from './core/config/index.js';
import { httpConfig } from './core/http/http.config.js';

export async function bootstrapApi(
  opts: { listen?: boolean } = {},
): Promise<INestApplication> {
  process.env.APP_ROLE = 'api';
  validateAllConfigs();
  const app = await NestFactory.create(AppApiModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
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
      process.once('SIGTERM', () => {
        void app.close().then(() => process.exit(0));
      });
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exit(1);
    });
}
