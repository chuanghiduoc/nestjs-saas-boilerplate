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
    // Capture stdout/stderr (never `env`, which carries secrets) so a drift failure's CLI
    // diagnostic lands in the assertion message instead of only in a buffered CI log line.
    try {
      execFileSync(
        'pnpm',
        ['exec', 'auth', 'check', 'schema', '--config', CLI_CONFIG],
        {
          env: { ...process.env, ...baseTestEnv() },
          encoding: 'utf8',
          shell: process.platform === 'win32',
        },
      );
    } catch (err) {
      const out =
        typeof err === 'object' &&
        err !== null &&
        'stdout' in err &&
        'stderr' in err
          ? `${String(err.stdout)}${String(err.stderr)}`
          : String(err);
      throw new Error(`auth check schema failed:\n${out}`);
    }
  });
});
