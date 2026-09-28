import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APIError } from 'better-auth/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import {
  FORBIDDEN_BETTER_AUTH_ENV,
  identityConfig,
  identityGuardConfig,
} from '../../../../src/modules/identity/identity.config.js';
import {
  API_KEY_VALIDATION_LOG,
  CLIENT_INPUT_LOG_PREFIXES,
  classifyBetterAuthLog,
} from '../../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { authErrorUrl } from '../../../../src/modules/identity/infra/better-auth/auth-options.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';

const base: Record<string, string> = {
  APP_ROLE: 'api',
  NODE_ENV: 'development',
  REDIS_URL: 'redis://localhost:6379',
  DB_HOST: 'h',
  DB_NAME: 'n',
  DB_APP_PASSWORD: 'p',
  DB_AUTH_PASSWORD: 'p',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({
    k1: Buffer.alloc(32).toString('base64'),
  }),
  FIELD_ENCRYPTION_ACTIVE_KID: 'k1',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  AUTH_BASE_URL: 'http://localhost:3000',
  AUTH_SECURE_COOKIES: 'false',
  HTTP_CORS_ORIGINS: 'http://localhost:5173',
};
const stub = (env: Record<string, string>) => {
  vi.unstubAllEnvs();
  // Vitest/CI không được tự có sẵn các biến này; xoá để test không phụ thuộc môi trường chạy.
  for (const name of FORBIDDEN_BETTER_AUTH_ENV) vi.stubEnv(name, undefined);
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
};

describe('Better Auth environment overrides are refused (Task 40 M5)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('boots without them', () => {
    stub({});
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it.each(FORBIDDEN_BETTER_AUTH_ENV)(
    '%s present (even empty) → boot fails naming the variable',
    (name) => {
      for (const value of ['x', '']) {
        stub({ [name]: value });
        expect(() => validateAllConfigs()).toThrow(
          new RegExp(
            `identity-no-better-auth-env-overrides: ${name} must not be set`,
          ),
        );
      }
    },
  );
});

describe('onAPIError.errorURL is explicit (Task 40 M6)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the root of AUTH_BASE_URL, or AUTH_ERROR_URL when set', () => {
    stub({});
    expect(authErrorUrl(identityConfig())).toBe('http://localhost:3000/');
    stub({ AUTH_ERROR_URL: 'http://localhost:5173/auth/error' });
    expect(authErrorUrl(identityConfig())).toBe(
      'http://localhost:5173/auth/error',
    );
  });
  it('AUTH_ERROR_URL must be http(s) on a trusted origin', () => {
    stub({ AUTH_ERROR_URL: 'https://evil.test/e' });
    expect(() => validateAllConfigs()).toThrow(
      /AUTH_ERROR_URL must be on a trusted origin/,
    );
    stub({ AUTH_ERROR_URL: 'javascript:alert(1)' });
    expect(() => validateAllConfigs()).toThrow(/AUTH_ERROR_URL/);
    stub({ AUTH_ERROR_URL: 'http://localhost:5173/auth/error' });
    expect(() => validateAllConfigs()).not.toThrow();
  });
});

describe('anti-enumeration response floor (S2-R58)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 300 ms and accepts 0 outside production', () => {
    stub({});
    expect(identityGuardConfig().enumerationMinResponseMs).toBe(300);
    stub({ AUTH_ENUMERATION_MIN_RESPONSE_MS: '0' });
    expect(identityGuardConfig().enumerationMinResponseMs).toBe(0);
  });
  it('production requires it to be > 0', () => {
    stub({
      AUTH_SECURE_COOKIES: 'true',
      AUTH_BASE_URL: 'https://api.example.test',
    });
    const rule = productionRuleRegistry().find(
      (entry) => entry.name === 'identity-production',
    );
    if (!rule) throw new Error('Missing identity-production rule');
    const identity = identityConfig();
    const guard = identityGuardConfig();
    expect(rule.rule({ identity, identityGuard: guard })).toBeUndefined();
    expect(
      rule.rule({
        identity,
        identityGuard: { ...guard, enumerationMinResponseMs: 0 },
      }),
    ).toMatch(/AUTH_ENUMERATION_MIN_RESPONSE_MS must be > 0/);
  });
});

describe('Better Auth log lines driven by client input (S2-R59)', () => {
  it.each(CLIENT_INPUT_LOG_PREFIXES)(
    '"%s: <value>" → warn, the client value is dropped',
    (prefix) => {
      expect(
        classifyBetterAuthLog(
          'error',
          `${prefix}: https://evil.test/?u=a@b.io`,
          [],
        ),
      ).toEqual({ level: 'warn', message: prefix, clientInput: true });
    },
  );
  it('only the exact prefixes are downgraded', () => {
    expect(
      classifyBetterAuthLog('error', 'Invalid callbackURLs everywhere', []),
    ).toMatchObject({ level: 'error', clientInput: false });
    expect(
      classifyBetterAuthLog('error', 'Something failed for a@b.io', []),
    ).toEqual({
      level: 'error',
      message: 'Something failed for [email]',
      clientInput: false,
    });
  });
  it('"Failed to validate API key:" → warn for an APIError (junk key), ERROR otherwise (storage)', () => {
    expect(
      classifyBetterAuthLog('error', API_KEY_VALIDATION_LOG, [
        new APIError('UNAUTHORIZED', { message: 'Invalid API key.' }),
      ]),
    ).toMatchObject({ level: 'warn', clientInput: true });
    expect(
      classifyBetterAuthLog('error', API_KEY_VALIDATION_LOG, [
        Object.assign(new Error('permission denied'), { code: '42501' }),
      ]),
    ).toMatchObject({ level: 'error', clientInput: false });
    expect(
      classifyBetterAuthLog('error', API_KEY_VALIDATION_LOG, []),
    ).toMatchObject({ level: 'error', clientInput: false });
  });
});

/** Drift: một bản nâng cấp đổi chữ của các dòng này thì S2-R59 âm thầm hết tác dụng; test phải vỡ. */
describe('the classified Better Auth log texts still exist in the installed dist (drift)', () => {
  // Bản đã cài của dự án (symlink pnpm ở `node_modules/<pkg>`); `exports` của hai package không mở `package.json`.
  const read = (pkg: string, file: string) =>
    readFileSync(
      join(process.cwd(), 'node_modules', pkg, 'dist', file),
      'utf8',
    );

  it('origin-check of better-auth logs `Invalid ${label}: …` with exactly these labels, and `Invalid origin: …`', () => {
    const src = read('better-auth', 'api/middlewares/origin-check.mjs');
    expect(src).toContain(
      'ctx.context.logger.error(`Invalid ${label}: ${url}`)',
    );
    expect(src).toContain(
      'ctx.context.logger.error(`Invalid origin: ${originToValidate}`)',
    );
    for (const prefix of CLIENT_INPUT_LOG_PREFIXES.filter(
      (p) => p !== 'Invalid origin',
    )) {
      const label = prefix.replace('Invalid ', '');
      expect(src).toContain(`validateURL(${label}, "${label}")`);
    }
  });
  it('@better-auth/api-key logs the validation failure with the error as first argument', () => {
    const src = read('@better-auth/api-key', 'index.mjs');
    expect(src).toContain(
      `ctx.context.logger.error("${API_KEY_VALIDATION_LOG}", error)`,
    );
  });
});
