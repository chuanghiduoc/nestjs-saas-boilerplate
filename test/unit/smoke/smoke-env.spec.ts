import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_EXAMPLE,
  INFRA_EXAMPLE,
  buildSmokeEnv,
  readEnvExample,
  smokeSubnet,
  type SmokeEnv,
} from '../../smoke/smoke-env.js';
import {
  missingSmokeVariables,
  overlappingSubnets,
  type RenderedCompose,
} from '../../smoke/smoke-preflight.js';

const renderedWith = (
  environment: Record<string, string>,
): RenderedCompose => ({
  services: {
    api: { environment },
    worker: { environment },
    migrate: { environment },
  },
});

describe('smoke env is derived from the generated env examples (review B3)', () => {
  let env: SmokeEnv | undefined;
  afterEach(() => {
    if (env) rmSync(env.dir, { recursive: true, force: true });
    env = undefined;
    vi.unstubAllEnvs();
  });

  it('every key of .env.infra.example reaches the compose interpolation file, required ones non-empty', () => {
    env = buildSmokeEnv(() => ({}));
    const example = readEnvExample(INFRA_EXAMPLE);
    for (const k of Object.keys(example.values))
      expect(env.infra[k], k).toBeDefined();
    expect(example.values.DB_APP_STATEMENT_TIMEOUT_MS).toBeDefined();
    expect(env.requiredInfra).toContain('POSTGRES_SUPERUSER_PASSWORD');
    for (const k of env.requiredInfra) expect(env.infra[k], k).not.toBe('');
  });
  it('required app keys are known and the app file is written with forward slashes (review M9)', () => {
    env = buildSmokeEnv(() => ({}));
    expect(readEnvExample(APP_EXAMPLE).required).toEqual(
      expect.arrayContaining(['DB_APP_PASSWORD', 'FIELD_ENCRYPTION_KEYS']),
    );
    expect(env.infra.APP_ENV_FILE).not.toContain('\\');
  });
  it('preflight lists every missing variable by name and source', () => {
    env = buildSmokeEnv(() => ({}));
    const complete = renderedWith({
      DB_HOST: 'pgbouncer',
      REDIS_URL: 'rediss://x',
      ...env.app,
    });
    expect(missingSmokeVariables(env, complete, '')).toEqual([]);
    const withoutPassword = Object.fromEntries(
      Object.entries(env.app).filter(([k]) => k !== 'DB_APP_PASSWORD'),
    );
    const infraWithout = { ...env.infra, POSTGRES_SUPERUSER_PASSWORD: '' };
    const stderr =
      'WARN[0000] The "DB_AUTH_STATEMENT_TIMEOUT_MS" variable is not set. Defaulting to a blank string.';
    expect(
      missingSmokeVariables(
        { ...env, infra: infraWithout },
        renderedWith({
          DB_HOST: 'pgbouncer',
          REDIS_URL: 'rediss://x',
          ...withoutPassword,
        }),
        stderr,
      ),
    ).toEqual([
      'DB_APP_PASSWORD (service api)',
      'DB_APP_PASSWORD (service migrate)',
      'DB_APP_PASSWORD (service worker)',
      'DB_AUTH_STATEMENT_TIMEOUT_MS (compose interpolation)',
      'POSTGRES_SUPERUSER_PASSWORD (.env.infra)',
    ]);
  });
  it('preflight also reads the logfmt warning compose prints when stderr is not a TTY', () => {
    env = buildSmokeEnv(() => ({}));
    const complete = renderedWith({
      DB_HOST: 'pgbouncer',
      REDIS_URL: 'rediss://x',
      ...env.app,
    });
    // Nguyên văn stderr của `docker compose config` (Compose v5.4.0) khi chạy qua pipe.
    const stderr =
      'time="2026-09-27T21:44:58+07:00" level=warning msg="The \\"DB_APP_STATEMENT_TIMEOUT_MS\\" variable is not set. Defaulting to a blank string."';
    expect(missingSmokeVariables(env, complete, stderr)).toEqual([
      'DB_APP_STATEMENT_TIMEOUT_MS (compose interpolation)',
    ]);
  });
  it('SMOKE_SUBNET is overridable, validated, and checked for overlaps', () => {
    vi.stubEnv('SMOKE_SUBNET', '10.99.0.0/24');
    expect(smokeSubnet()).toBe('10.99.0.0/24');
    vi.stubEnv('SMOKE_SUBNET', '10.999.0.0/24');
    expect(() => smokeSubnet()).toThrow(/IPv4 CIDR/);
    expect(
      overlappingSubnets('172.31.250.0/24', ['172.16.0.0/12', '10.0.0.0/8']),
    ).toEqual(['172.16.0.0/12']);
    expect(overlappingSubnets('172.31.250.0/24', ['172.31.251.0/24'])).toEqual(
      [],
    );
  });
  it('an invalid SMOKE_SUBNET fails before any temp dir is created (no leaked secrets on disk)', () => {
    const before = readdirSync(tmpdir()).filter((d) =>
      d.startsWith('nsb-smoke-'),
    ).length;
    vi.stubEnv('SMOKE_SUBNET', 'bad');
    expect(() => buildSmokeEnv(() => ({}))).toThrow(/IPv4 CIDR/);
    expect(
      readdirSync(tmpdir()).filter((d) => d.startsWith('nsb-smoke-')).length,
    ).toBe(before);
  });
});
