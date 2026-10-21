import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { readImages } from '../support/images.js';
import { smokeAppEnv } from './smoke-app-env.js';
import {
  SMOKE_DB,
  SMOKE_SUPERUSER,
  buildSmokeEnv,
  type SmokeEnv,
} from './smoke-env.js';
import { assertSmokePreflight } from './smoke-preflight.js';

export type SmokeContext = {
  apiUrl: string;
  mailpitApiUrl: string;
  dashboardUrl: string;
  composeArgs: string[];
  dbName: string;
  superuser: string;
  /** Mốc lấy trước khi dựng bất kỳ service nào: kiểm log từ đây thì gồm cả log boot của api/worker. */
  startedAt: string;
  /** Tên project compose: network `<project>_default`, volume `<project>_smoke-certs` (CO-3 chạy `docker run` trên đó). */
  project: string;
  /** Image production vừa build (tag riêng của project). */
  appImage: string;
  /** File env app tạm (chứa secret của smoke, xoá ở teardown); CO-3 dựng env Job migrate từ nó. */
  appEnvFile: string;
};
declare module 'vitest' {
  export interface ProvidedContext {
    smoke: SmokeContext;
  }
}

let env: SmokeEnv | undefined;
let composeArgs: string[] = [];
const docker = (args: string[]) =>
  execFileSync('docker', args, { stdio: 'inherit' });

export async function setup(project: TestProject): Promise<void> {
  const images = readImages();
  env = buildSmokeEnv(smokeAppEnv);
  composeArgs = [
    'compose',
    '-p',
    env.project,
    '--env-file',
    'docker/images.env',
    '--env-file',
    env.infraFile,
    '--env-file',
    env.appFile,
    '-f',
    'compose.yaml',
    '-f',
    'test/smoke/compose.smoke.yaml',
  ];
  // Fail sớm, trước khi build image vài phút, với tên biến thiếu (review B3).
  try {
    assertSmokePreflight(env, composeArgs);
  } catch (err) {
    rmSync(env.dir, { recursive: true, force: true });
    env = undefined;
    composeArgs = [];
    throw err;
  }
  try {
    // Trạng thái sót của lần chạy bị ngắt: volume pgdata (giữ mật khẩu cũ vì Postgres bỏ qua init khi đã
    // có data), volume chứng chỉ, network, container mồ côi, và file env tạm. Dọn hết trước khi build.
    docker([
      ...composeArgs,
      '--profile',
      'app',
      'down',
      '-v',
      '--remove-orphans',
    ]);
    removeStaleEnvDirs(env);
    const startedAt = new Date().toISOString();
    // Build đúng một lần; migrate/api/worker dùng chính image này (`pull_policy: never`, `build: !reset`
    // trong compose.smoke.yaml), nên mọi lệnh `compose run` sau đó không build lại từ working tree.
    docker([
      'build',
      '--build-arg',
      `BUILD_IMAGE=${images.IMAGE_NODE_BUILD}`,
      '--build-arg',
      `RUNTIME_IMAGE=${images.IMAGE_NODE_RUNTIME}`,
      '-t',
      env.appImage,
      '.',
    ]);
    // Dịch vụ một lần (sinh chứng chỉ) chạy riêng: `up --wait` có thể coi container đã thoát là lỗi.
    docker([...composeArgs, 'run', '--rm', 'smoke-certs']);
    docker([
      ...composeArgs,
      'up',
      '-d',
      '--wait',
      '--no-deps',
      'postgres',
      'redis',
      'mailpit',
    ]);
    docker([...composeArgs, 'up', '-d', '--wait', '--no-deps', 'pgbouncer']);
    docker([
      ...composeArgs,
      '--profile',
      'app',
      'run',
      '--rm',
      '--no-deps',
      'migrate',
    ]);
    // Số đo của bộ test (không phải config của app): api + worker tới healthy, ghi vào ADR 0013.
    const startupStartedAt = performance.now();
    docker([
      ...composeArgs,
      '--profile',
      'app',
      'up',
      '-d',
      '--wait',
      '--no-deps',
      '--no-build',
      'api',
      'worker',
    ]);
    process.stdout.write(
      `${JSON.stringify({ event: 'smoke_startup_ms', ms: Math.round(performance.now() - startupStartedAt) })}\n`,
    );
    project.provide('smoke', {
      apiUrl: `http://127.0.0.1:${env.ports.http}`,
      mailpitApiUrl: `http://127.0.0.1:${env.ports.mailpitUi}`,
      dashboardUrl: `http://127.0.0.1:${env.ports.dashboard}`,
      composeArgs,
      dbName: SMOKE_DB,
      superuser: SMOKE_SUPERUSER,
      startedAt,
      project: env.project,
      appImage: env.appImage,
      appEnvFile: env.appFile,
    });
  } catch (err) {
    await teardown();
    throw err;
  }
}

/**
 * Thư mục env tạm (chứa secret) của lần chạy trước cùng project mà teardown không kịp xoá (process bị
 * giết). Cùng project thì không chạy song song được (trùng tên container), nên xoá là an toàn.
 */
function removeStaleEnvDirs(current: SmokeEnv): void {
  for (const d of readdirSync(tmpdir())) {
    const path = join(tmpdir(), d);
    if (d.startsWith(`${current.project}-`) && path !== current.dir)
      rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Idempotent: vitest gọi lại teardown sau khi setup đã tự teardown vì lỗi; lần hai không còn gì để dọn
 * (file env đã xoá thì `compose down` sẽ fail vì thiếu `--env-file`).
 */
export async function teardown(): Promise<void> {
  const args = composeArgs;
  const dir = env?.dir;
  composeArgs = [];
  env = undefined;
  try {
    if (args.length) {
      try {
        docker([
          ...args,
          '--profile',
          'app',
          'logs',
          '--no-color',
          'api',
          'worker',
        ]);
      } finally {
        docker([...args, '--profile', 'app', 'down', '-v', '--remove-orphans']);
      }
    }
  } finally {
    // File env chứa secret của smoke: xoá cả khi `down` lỗi.
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
