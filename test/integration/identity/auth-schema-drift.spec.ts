import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseTestEnv } from '../../support/env.js';

const CLI_CONFIG = 'dist/modules/identity/infra/better-auth/auth.cli-config.js';

describe('Better Auth schema drift', () => {
  it('auth check schema passes on the migrated database', () => {
    expect(existsSync(CLI_CONFIG), 'run pnpm build first').toBe(true);
    // ADR 0010 S3c: generate reports false drift for existing auth tables.
    // baseTestEnv supplies APP_ROLE and the full app env, including Testcontainers DB credentials.
    expect(() =>
      execFileSync(
        'pnpm',
        ['exec', 'auth', 'check', 'schema', '--config', CLI_CONFIG],
        {
          env: { ...process.env, ...baseTestEnv() },
          stdio: 'inherit',
          shell: process.platform === 'win32',
        },
      ),
    ).not.toThrow();
  });
});
