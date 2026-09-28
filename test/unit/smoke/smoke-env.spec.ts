import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { smokeAppEnv } from '../../smoke/smoke-app-env.js';
import {
  APP_EXAMPLE,
  DEFAULT_SMOKE_PORT_BASE,
  DEFAULT_SMOKE_PROJECT,
  INFRA_EXAMPLE,
  buildSmokeEnv,
  readEnvExample,
  renderEnvFile,
  smokePorts,
  smokeProject,
  smokeSubnet,
  type SmokeEnv,
} from '../../smoke/smoke-env.js';
import { assertCleanLogs } from '../../smoke/smoke-support.js';
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
  it('SMOKE_SUBNET becomes COMPOSE_SUBNET of the smoke stack (network ipam + dashboard allowlist, Task 46)', () => {
    vi.stubEnv('SMOKE_SUBNET', '10.99.0.0/24');
    env = buildSmokeEnv(() => ({}));
    expect(env.infra.COMPOSE_SUBNET).toBe('10.99.0.0/24');
    expect(env.infra).not.toHaveProperty('SMOKE_SUBNET');
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
  it('SMOKE_SUBNET must be the canonical network address (no host bits)', () => {
    vi.stubEnv('SMOKE_SUBNET', '172.31.250.7/24');
    expect(() => smokeSubnet()).toThrow(/network address.*172\.31\.250\.0\/24/);
    vi.stubEnv('SMOKE_SUBNET', '10.99.0.0/33');
    expect(() => smokeSubnet()).toThrow(/IPv4 CIDR/);
  });
  it('SMOKE_PROJECT and SMOKE_PORT_BASE are overridable so two worktrees can run side by side', () => {
    expect(smokeProject()).toBe(DEFAULT_SMOKE_PROJECT);
    expect(smokePorts().http).toBe(DEFAULT_SMOKE_PORT_BASE);
    vi.stubEnv('SMOKE_PROJECT', 'nsb-smoke-b');
    vi.stubEnv('SMOKE_PORT_BASE', '39400');
    expect(smokeProject()).toBe('nsb-smoke-b');
    expect(Object.values(smokePorts()).sort((a, b) => a - b)).toEqual([
      39400, 39401, 39402, 39403, 39404, 39405, 39406, 39407,
    ]);
    env = buildSmokeEnv(() => ({}));
    expect(env.project).toBe('nsb-smoke-b');
    expect(env.ports.http).toBe(39400);
    expect(env.infra.HTTP_PORT_HOST).toBe('39400');
    expect(env.infra.SMOKE_APP_IMAGE).toBe(
      'nestjs-saas-boilerplate:nsb-smoke-b',
    );
    vi.stubEnv('SMOKE_PROJECT', 'Bad Name');
    expect(() => smokeProject()).toThrow(/SMOKE_PROJECT/);
    vi.stubEnv('SMOKE_PORT_BASE', '65530');
    expect(() => smokePorts()).toThrow(/SMOKE_PORT_BASE/);
    vi.stubEnv('SMOKE_PORT_BASE', '80');
    expect(() => smokePorts()).toThrow(/SMOKE_PORT_BASE/);
  });
  it('env files quote values so #, ", $ and spaces round-trip through compose; unquotable values fail loud', () => {
    expect(renderEnvFile({ A: 'x #y "z" $w ${V} <a@b>' })).toBe(
      `A='x #y "z" $w \${V} <a@b>'\n`,
    );
    expect(() => renderEnvFile({ A: "it's" })).toThrow(/A/);
    expect(() => renderEnvFile({ A: 'a\nb' })).toThrow(/A/);
    expect(() => renderEnvFile({ A: 'ends\\' })).toThrow(/A/);
  });
  it('smoke app env keeps production mail settings (STARTTLS + certificate check) with a test sender; SMTP host/port come from compose.yaml (worker only, Task 43)', () => {
    env = buildSmokeEnv(smokeAppEnv);
    expect(env.app.MAIL_FROM).toMatch(/<[^@\s]+@[^>\s]+>$/);
    expect(env.app.SMTP_REQUIRE_TLS).toBe('true');
    expect(env.app.SMTP_TLS_REJECT_UNAUTHORIZED).toBe('true');
    expect(env.app.SMTP_HOST).toBeUndefined();
  });
});

describe('assertCleanLogs', () => {
  const info = JSON.stringify({ level: 30, msg: 'ok' });
  it('passes JSON lines below error level', () => {
    expect(() => assertCleanLogs(`${info}\n${info}\n`, [])).not.toThrow();
  });
  it('fails on error/fatal lines, forbidden strings, and any non-JSON line', () => {
    expect(() =>
      assertCleanLogs(JSON.stringify({ level: 50, msg: 'x' }), []),
    ).toThrow();
    expect(() => assertCleanLogs(info, ['ok'])).toThrow();
    expect(() =>
      assertCleanLogs(`${info}\n(node:1) Warning: something`, []),
    ).toThrow(/non-JSON/);
    expect(() => assertCleanLogs('{not json', [])).toThrow(/non-JSON/);
  });
});
