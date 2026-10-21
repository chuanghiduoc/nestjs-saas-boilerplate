import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../src/core/config/all-configs.js';
// Composition thật như main.api/main.worker: mọi module đang bật đăng ký config và luật của nó (top-level await).
import '../../../src/app.modules.js';
import {
  ConfigValidationError,
  configRegistry,
  secretFieldsOf,
  validateAllConfigs,
} from '../../../src/core/config/index.js';
import {
  ROLE_CELLS,
  cellEnv,
  requiredSecretsOf,
  type RoleCell,
} from '../../support/role-config-env.js';

const fields = secretFieldsOf(configRegistry());
const label = (c: RoleCell) =>
  `${c.role} ${c.nodeEnv} ${c.mode} smtpAuth=${c.smtpAuth} google=${c.google}`;
const stub = (env: Record<string, string>) => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  // Khoá không có trong ô phải VẮNG hẳn (`undefined` xoá biến, Vitest 5), kể cả khi process của test có sẵn.
  for (const f of fields) if (!(f.env in env)) vi.stubEnv(f.env, undefined);
};
const issuesOf = (fn: () => void): { env: string; message: string }[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigValidationError) return e.issues;
    throw e;
  }
  return [];
};

describe('CO-4: every role validates with only its own secrets (spec SP7 §19, C3, S7-D33)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(ROLE_CELLS.map((c) => [label(c), c] as const))(
    '%s: green with exactly the secrets the code declares for the role',
    (_name, cell) => {
      stub(cellEnv(cell, fields));
      expect(issuesOf(() => validateAllConfigs())).toEqual([]);
    },
  );

  it.each(ROLE_CELLS.map((c) => [label(c), c] as const))(
    '%s: dropping any secret a rule requires fails with that env name',
    (_name, cell) => {
      const env = cellEnv(cell, fields);
      for (const name of requiredSecretsOf(cell)) {
        expect(env[name], `${name} must be part of the cell`).toBeDefined();
        stub(
          Object.fromEntries(Object.entries(env).filter(([k]) => k !== name)),
        );
        const issues = issuesOf(() => validateAllConfigs());
        expect(
          issues.some((i) => i.env === name || i.message.includes(name)),
          `${name}: ${JSON.stringify(issues)}`,
        ).toBe(true);
      }
    },
  );
});
