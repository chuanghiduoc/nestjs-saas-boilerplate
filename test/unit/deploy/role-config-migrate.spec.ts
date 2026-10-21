import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Đúng ba namespace mà main.migrate.ts nạp (spec SP7 §12.4); không all-configs, không composition.
import '../../../src/core/config/app.config.js';
import '../../../src/core/logging/logging.config.js';
import '../../../src/core/database/database.config.js';
import {
  configRegistry,
  secretFieldsOf,
  validateAllConfigs,
} from '../../../src/core/config/index.js';
import {
  SECRET_TEST_VALUES,
  nonSecretBase,
} from '../../support/role-config-env.js';

const fields = secretFieldsOf(configRegistry());

describe('the migrate role validates with DB_OWNER_PASSWORD only (spec SP7 §12.4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['development', 'production'] as const)(
    '%s: green with only the secrets declared for migrate',
    (nodeEnv) => {
      const env: Record<string, string> = {
        ...nonSecretBase(nodeEnv, new Set(fields.map((f) => f.env))),
        APP_ROLE: 'migrate',
      };
      for (const f of fields)
        if (f.roles.includes('migrate'))
          env[f.env] = SECRET_TEST_VALUES[f.env] ?? '';
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      for (const f of fields) if (!(f.env in env)) vi.stubEnv(f.env, undefined);
      expect(() => validateAllConfigs()).not.toThrow();
      expect(env.DB_OWNER_PASSWORD).toBe(SECRET_TEST_VALUES.DB_OWNER_PASSWORD);
      expect(env.DB_APP_PASSWORD).toBeUndefined();
    },
  );
  it('main.migrate.ts loads exactly the app, logging and database config namespaces', () => {
    const src = readFileSync('src/main.migrate.ts', 'utf8');
    expect(src).not.toContain('all-configs');
    expect(
      [...src.matchAll(/^import '(\.\/core\/[^']+\.config\.js)';$/gm)].map(
        (m) => m[1],
      ),
    ).toEqual([
      './core/config/app.config.js',
      './core/logging/logging.config.js',
      './core/database/database.config.js',
    ]);
    expect(configRegistry().map((e) => e.namespace)).toEqual([
      'app',
      'logging',
      'database',
    ]);
  });
});
