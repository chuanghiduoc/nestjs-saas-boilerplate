import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getInfra } from '../../../support/infra.js';
import {
  createScratchDb,
  type ScratchDb,
} from '../../../support/scratch-db.js';

const ENTRY = 'dist/main.migrate.js';
const RUN_TIMEOUT_MS = 60_000;
/** Biến của hệ điều hành mà process Node cần (Windows: SystemRoot/TEMP); không phải config của app. */
const PLATFORM_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
];
const Output = z.object({
  cmd: z.literal('status'),
  migrations: z.array(z.string()),
});

describe('migrate boots with only the Job env of the chart (spec SP7 §12.4)', () => {
  let scratch: ScratchDb;
  beforeAll(async () => {
    if (!existsSync(ENTRY))
      throw new Error(
        `${ENTRY} is missing; run pnpm build first (CI builds before test:int)`,
      );
    scratch = await createScratchDb('migrate_min');
  });
  afterAll(async () => {
    await scratch?.drop();
  });

  const jobEnv = (): Record<string, string> => {
    const { pg } = getInfra();
    const platform = Object.fromEntries(
      PLATFORM_KEYS.flatMap((k) =>
        process.env[k] ? [[k, process.env[k] ?? '']] : [],
      ),
    );
    // Không REDIS_URL, không FIELD_ENCRYPTION_KEYS, không DB_APP_PASSWORD: đúng tập mà chart nhúng vào Job.
    return {
      ...platform,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DB_HOST: pg.host,
      DB_PORT: String(pg.port),
      DB_NAME: scratch.name,
      DB_MIGRATION_HOST: pg.host,
      DB_MIGRATION_PORT: String(pg.port),
      DB_OWNER_USER: pg.owner.user,
      DB_OWNER_PASSWORD: pg.owner.password,
      DB_SSL_MODE: 'disable',
    };
  };
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [ENTRY, 'status'], {
      env,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
    });

  it('status succeeds and lists the pending migrations', () => {
    const r = run(jobEnv());
    expect(r.status, r.stderr).toBe(0);
    const out = Output.parse(
      JSON.parse(r.stdout.trim().split('\n').at(-1) ?? ''),
    );
    expect(out.migrations.length).toBeGreaterThan(0);
  });

  it('without DB_OWNER_PASSWORD it exits 1 naming the variable', () => {
    const { DB_OWNER_PASSWORD: _owner, ...env } = jobEnv();
    const r = run(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'DB_OWNER_PASSWORD is required to run migrations',
    );
  });
});
