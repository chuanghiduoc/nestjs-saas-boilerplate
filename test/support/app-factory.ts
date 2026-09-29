import {
  type DynamicModule,
  type INestApplication,
  Module,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
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
/** Sửa `TestingModuleBuilder` trước `compile()` (ví dụ `overrideProvider`). */
export type ConfigureTestingModule = (
  b: TestingModuleBuilder,
) => TestingModuleBuilder;

export function applyTestEnv(): void {
  for (const [k, v] of Object.entries(baseTestEnv()))
    if (process.env[k] === undefined) vi.stubEnv(k, v);
}

/**
 * Dựng app như `createTestApp` nhưng KHÔNG init(): cho spec cần kiểm lỗi lúc boot (hook `onModuleInit`/
 * `onApplicationBootstrap` ném) mà vẫn giữ được handle để `close()` giải phóng tài nguyên đã mở.
 */
export async function buildTestApp(
  imports: ModuleImport[],
  opts: { bodyParser?: boolean; configure?: ConfigureTestingModule } = {},
): Promise<INestApplication> {
  applyTestEnv();
  validateAllConfigs();
  const builder = Test.createTestingModule({
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
  });
  const moduleRef = await (
    opts.configure ? opts.configure(builder) : builder
  ).compile();
  return moduleRef.createNestApplication(
    opts.bodyParser === true ? { rawBody: true } : { bodyParser: false },
  );
}

/**
 * Luôn init() để onApplicationBootstrap chạy (worker, relay, scheduler). Không listen cổng.
 * Mặc định tạo app giống `main.api.ts` (`bodyParser: false`, ruling S2-R10): spec HTTP gọi
 * `beforeInit: applyHttpDefaults` để chạy đúng parser production (`jsonBodyParser`). Spec nào thật sự cần parser
 * mặc định của Nest phải truyền `bodyParser: true` và ghi rõ lý do.
 */
export async function createTestApp(
  imports: ModuleImport[],
  opts: {
    beforeInit?: (app: INestApplication) => void;
    bodyParser?: boolean;
    configure?: ConfigureTestingModule;
  } = {},
): Promise<INestApplication> {
  const app = await buildTestApp(imports, opts);
  opts.beforeInit?.(app);
  await app.init();
  return app;
}

/**
 * Bọc `mod` trong `depth` module rỗng. Nest sắp middleware theo `distance` (độ sâu lớn nhất trong cây import), nên đây
 * là cách test dựng được cả hai thứ tự `PrincipalMiddleware`/`OrgContextMiddleware` (spec SP3 §7.1 bước 2, T6).
 */
export function nestedIn(mod: ModuleImport, depth: number): ModuleImport {
  let current = mod;
  for (let i = 0; i < depth; i++) {
    const inner = current;
    @Module({ imports: [inner] })
    class NestingModule {}
    current = NestingModule;
  }
  return current;
}
