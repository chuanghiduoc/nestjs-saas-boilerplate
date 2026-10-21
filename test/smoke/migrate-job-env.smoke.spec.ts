import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { MIGRATION_ADVISORY_LOCK } from '../../src/core/database/index.js';
import { SECRET_ENV_FILE } from '../../src/scripts/chart-secrets.js';
import { psql } from './smoke-support.js';

/** Luật env của Job migrate trong chart (spec SP7 §12.4, `templates/migrate-job.yaml`): các tiền tố này cộng NODE_ENV. */
const JOB_ENV_PREFIXES = ['APP_', 'LOG_', 'DB_'];
/** `config` của chart cho Job: đi thẳng Postgres (Ruling R8), cùng giá trị service `migrate` của compose.yaml. */
const JOB_DB_CONFIG = {
  DB_HOST: 'postgres',
  DB_PORT: '5432',
  DB_MIGRATION_HOST: 'postgres',
  DB_MIGRATION_PORT: '5432',
};
const RUN_TIMEOUT_MS = 120_000;
const Allow = z.record(
  z.string(),
  z.array(z.enum(['api', 'worker', 'migrate'])),
);
const Out = z.object({ cmd: z.string(), migrations: z.array(z.string()) });

function migrateJobEnv(
  app: Record<string, string>,
  allow: Record<string, readonly string[]>,
): Record<string, string> {
  const out: Record<string, string> = { ...JOB_DB_CONFIG };
  for (const [k, v] of Object.entries(app))
    if (
      !(k in allow) &&
      (k === 'NODE_ENV' || JOB_ENV_PREFIXES.some((p) => k.startsWith(p)))
    )
      out[k] = v;
  Object.assign(out, JOB_DB_CONFIG);
  for (const [k, roles] of Object.entries(allow)) {
    if (!roles.includes('migrate')) continue;
    const v = app[k];
    if (!v)
      throw new Error(`smoke env has no ${k}, which the migrate role receives`);
    out[k] = v;
  }
  out.APP_ROLE = 'migrate';
  return out;
}

describe('prod-like smoke: the chart migrate Job env on the production image (spec SP7 §12.4)', () => {
  const { project, appImage, appEnvFile } = inject('smoke');
  const app = Object.fromEntries(
    Object.entries(parseEnv(readFileSync(appEnvFile, 'utf8'))).flatMap(
      ([k, v]) => (typeof v === 'string' ? [[k, v]] : []),
    ),
  );
  const allow = Allow.parse(JSON.parse(readFileSync(SECRET_ENV_FILE, 'utf8')));
  const run = (env: Record<string, string>, args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), `${project}-migrate-`));
    const file = join(dir, 'job.env');
    try {
      writeFileSync(
        file,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      );
      return spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          `${project}_default`,
          '-v',
          `${project}_smoke-certs:/certs:ro`,
          '--env-file',
          file,
          appImage,
          'dist/main.migrate.js',
          ...args,
        ],
        { encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
      );
    } finally {
      // File chứa DB_OWNER_PASSWORD của smoke: xoá ở mọi nhánh.
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('the Job env holds only APP_/LOG_/DB_/NODE_ENV and the migrate secrets: no Redis, field keys or app/relay/auth passwords', () => {
    const env = migrateJobEnv(app, allow);
    expect(env.NODE_ENV).toBe('production');
    expect(env.DB_SSL_MODE).toBe('verify-full');
    expect(env.DB_OWNER_PASSWORD).toBeTruthy();
    // Tập secret đầy đủ lấy từ allowlist sinh từ code, không từ danh sách viết tay.
    const others = Object.entries(allow).filter(
      ([, roles]) => !roles.includes('migrate'),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const [k] of others) expect(env[k], k).toBeUndefined();
    expect(Object.keys(env).filter((k) => k in allow)).toEqual(
      Object.entries(allow)
        .filter(([, roles]) => roles.includes('migrate'))
        .map(([k]) => k),
    );
  });

  it('status and up succeed on the production image with exactly that env (NODE_ENV=production, TLS verify-full)', () => {
    const env = migrateJobEnv(app, allow);
    for (const cmd of ['status', 'up']) {
      const r = run(env, [cmd]);
      expect(r.status, `${cmd}: ${r.stderr}`).toBe(0);
      const out = Out.parse(
        JSON.parse(r.stdout.trim().split('\n').at(-1) ?? ''),
      );
      expect(out).toEqual({ cmd, migrations: [] });
    }
    expect(
      psql(
        `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = ${MIGRATION_ADVISORY_LOCK.namespace} AND objid = ${MIGRATION_ADVISORY_LOCK.key} AND objsubid = 2`,
      ),
    ).toBe('0');
  });

  it('without DB_OWNER_PASSWORD the Job exits 1 naming it', () => {
    const { DB_OWNER_PASSWORD: _owner, ...env } = migrateJobEnv(app, allow);
    const r = run(env, ['status']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'DB_OWNER_PASSWORD is required to run migrations',
    );
  });
});
