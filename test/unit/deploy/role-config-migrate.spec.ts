import { afterEach, describe, expect, it, vi } from 'vitest';
// Đúng ba namespace mà main.migrate.ts nạp (spec SP7 S7-D25); không all-configs, không composition.
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

describe('CO-4 (migrate): the migrate role validates with DB_OWNER_PASSWORD only (spec SP7 S7-D25, C3)', () => {
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
});
