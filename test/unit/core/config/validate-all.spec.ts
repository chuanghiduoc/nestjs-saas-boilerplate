import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigValidationError,
  defineConfig,
  defineConfigRule,
  defineProductionRule,
  validateAllConfigs,
} from '../../../../src/core/config/index.js';

describe('validateAllConfigs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports issues from every namespace at once', () => {
    defineConfig('va1', { a: 'VA1_A' }, z.object({ a: z.string().min(1) }));
    defineConfig('va2', { b: 'VA2_B' }, z.object({ b: z.string().min(1) }));
    try {
      validateAllConfigs();
      expect.unreachable();
    } catch (e) {
      const envs = (e as ConfigValidationError).issues.map((i) => i.env);
      expect(envs).toEqual(expect.arrayContaining(['VA1_A', 'VA2_B']));
    }
  });

  it('applies production rules only in production', () => {
    vi.stubEnv('VA1_A', 'x');
    vi.stubEnv('VA2_B', 'y');
    vi.stubEnv('APP_ROLE', 'api');
    defineProductionRule('va1-not-x', (cfg) =>
      cfg.va1?.a === 'x' ? 'VA1_A must not be x in production' : undefined,
    );
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => validateAllConfigs()).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => validateAllConfigs()).toThrow(/VA1_A must not be x/);
  });

  it('applies config rules in every environment', () => {
    vi.stubEnv('VA1_A', 'y');
    vi.stubEnv('VA2_B', 'y');
    vi.stubEnv('APP_ROLE', 'api');
    vi.stubEnv('NODE_ENV', 'development');
    defineConfigRule('va-differ', (cfg) =>
      cfg.va1?.a === cfg.va2?.b ? 'VA1_A and VA2_B must differ' : undefined,
    );
    expect(() => validateAllConfigs()).toThrow(/VA1_A and VA2_B must differ/);
    vi.stubEnv('VA2_B', 'z');
    expect(() => validateAllConfigs()).not.toThrow();
  });
});
