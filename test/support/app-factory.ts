import {
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import '../../src/core/config/all-configs.js';
import {
  configFactories,
  validateAllConfigs,
} from '../../src/core/config/index.js';
import { ContextModule } from '../../src/core/context/index.js';
import { ProblemDetailsFilter } from '../../src/core/errors/index.js';
import { baseTestEnv } from './env.js';

export type ModuleImport = Type<unknown> | DynamicModule;

export function applyTestEnv(): void {
  for (const [k, v] of Object.entries(baseTestEnv()))
    if (process.env[k] === undefined) vi.stubEnv(k, v);
}

/** Luôn init() để onApplicationBootstrap chạy (worker, relay, scheduler). Không listen cổng. */
export async function createTestApp(
  imports: ModuleImport[],
  opts: { beforeInit?: (app: INestApplication) => void } = {},
): Promise<INestApplication> {
  applyTestEnv();
  validateAllConfigs();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: configFactories(),
      }),
      ContextModule,
      ...imports,
    ],
    providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  opts.beforeInit?.(app);
  await app.init();
  return app;
}
