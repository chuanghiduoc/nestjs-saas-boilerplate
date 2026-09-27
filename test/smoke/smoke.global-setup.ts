import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { readImages } from '../support/images.js';
import { smokeAppEnv } from './smoke-app-env.js';
import {
  SMOKE_DB,
  SMOKE_PORTS,
  SMOKE_PROJECT,
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
};
declare module 'vitest' {
  export interface ProvidedContext {
    smoke: SmokeContext;
  }
}

/** Trùng `image:` của `x-app` trong compose.yaml: compose dùng lại image vừa build. */
const APP_IMAGE = 'nestjs-saas-boilerplate:local';
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
    SMOKE_PROJECT,
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
    docker([
      'build',
      '--build-arg',
      `BUILD_IMAGE=${images.IMAGE_NODE_BUILD}`,
      '--build-arg',
      `RUNTIME_IMAGE=${images.IMAGE_NODE_RUNTIME}`,
      '-t',
      APP_IMAGE,
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
  } catch (err) {
    await teardown();
    throw err;
  }
  project.provide('smoke', {
    apiUrl: `http://127.0.0.1:${SMOKE_PORTS.http}`,
    mailpitApiUrl: `http://127.0.0.1:${SMOKE_PORTS.mailpitUi}`,
    dashboardUrl: `http://127.0.0.1:${SMOKE_PORTS.dashboard}`,
    composeArgs,
    dbName: SMOKE_DB,
    superuser: SMOKE_SUPERUSER,
  });
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
        docker([...args, '--profile', 'app', 'down', '-v']);
      }
    }
  } finally {
    // File env chứa secret của smoke: xoá cả khi `down` lỗi.
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
