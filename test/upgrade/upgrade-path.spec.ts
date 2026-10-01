import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTestEnv } from '../support/env.js';
import { getInfra } from '../support/infra.js';
import { createScratchDb, type ScratchDb } from '../support/scratch-db.js';

const OLD_DIR = process.env.UPGRADE_OLD_DIR;
/** Api boot từ `dist` trên DB vừa migrate: rộng hơn nhiều so với thực tế. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const STOP_TIMEOUT_MS = 30_000;

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() =>
        typeof a === 'object' && a
          ? ok(a.port)
          : fail(new Error('no free port')),
      );
    });
  });

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(
    `${url} not ready within ${READY_TIMEOUT_MS}ms (last: ${last})`,
  );
}

/**
 * Job "upgrade path" của `.github/workflows/upstream-guard.yml` (spec SP7 §13.4, UP-10): migrate bằng bản build trước
 * merge đồng bộ upstream, rồi bằng bản build sau — đúng thứ tự production gặp (migration upstream timestamp cũ chạy sau
 * migration của dự án, S7-D31) — và api bản mới phải tới `/health/ready`.
 */
describe('upgrade path: previous build, then this build (UP-10)', () => {
  if (!OLD_DIR)
    throw new Error(
      'UPGRADE_OLD_DIR must point at a built checkout of the previous commit (see .github/workflows/upstream-guard.yml, job upgrade-path)',
    );
  const oldDir = resolve(OLD_DIR);
  let scratch: ScratchDb | undefined;
  let env: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    scratch = await createScratchDb('upgrade_path');
    // PgBouncer của test chỉ khai database dùng chung (`[databases]` sinh từ DB_NAME), nên với database riêng mọi
    // pool của api (app, auth) đi thẳng Postgres; migration vốn đã đi thẳng (ruling R8).
    const { pg } = getInfra();
    env = {
      ...process.env,
      ...baseTestEnv(),
      DB_NAME: scratch.name,
      DB_HOST: pg.host,
      DB_PORT: String(pg.port),
      DB_AUTH_HOST: pg.host,
      DB_AUTH_PORT: String(pg.port),
    };
  });
  afterAll(async () => {
    await scratch?.drop();
  });
  const migrate = (dir: string, cmd: 'up' | 'status') =>
    execFileSync(process.execPath, ['dist/main.migrate.js', cmd], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });

  it('the previous build migrates an empty database, this build applies the rest, nothing stays pending', () => {
    migrate(oldDir, 'up');
    migrate(process.cwd(), 'up');
    expect(migrate(process.cwd(), 'status')).toContain('"migrations":[]');
  });

  it('the api of this build becomes ready on the upgraded database', async () => {
    const port = await freePort();
    const api = spawn(process.execPath, ['dist/main.api.js'], {
      env: { ...env, HTTP_HOST: '127.0.0.1', HTTP_PORT: String(port) },
      stdio: 'inherit',
    });
    const exited = new Promise<void>((r) => api.once('exit', () => r()));
    try {
      await waitReady(`http://127.0.0.1:${port}/health/ready`);
    } finally {
      api.kill('SIGTERM');
      const timer = setTimeout(() => api.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
  });
});
