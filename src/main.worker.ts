import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppWorkerModule } from './app-worker.module.js';
import { validateAllConfigs } from './core/config/index.js';
import { installShutdown } from './shutdown.js';

export async function bootstrapWorker(): Promise<INestApplicationContext> {
  process.env.APP_ROLE = 'worker';
  validateAllConfigs();
  const ctx = await NestFactory.createApplicationContext(AppWorkerModule, {
    bufferLogs: true,
  });
  ctx.useLogger(ctx.get(Logger));
  await ctx.init();
  return ctx;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapWorker()
    .then((ctx) => {
      installShutdown(ctx);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exit(1);
    });
}
