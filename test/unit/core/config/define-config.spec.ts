import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigValidationError,
  defineConfig,
} from '../../../../src/core/config/index.js';

const schema = z.object({
  port: z.coerce.number().int().positive().default(3000).describe('HTTP port'),
  secret: z.string().min(16).describe('Signing secret'),
});

describe('defineConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parses env into typed config with defaults', () => {
    vi.stubEnv('T_SECRET', 'x'.repeat(16));
    const cfg = defineConfig(
      't1',
      { port: 'T_PORT', secret: 'T_SECRET' },
      schema,
    );
    expect(cfg()).toEqual({ port: 3000, secret: 'x'.repeat(16) });
  });

  it('reports every invalid env var by name, never echoing values', () => {
    vi.stubEnv('T2_PORT', '-1');
    vi.stubEnv('T2_SECRET', 'too-short');
    const cfg = defineConfig(
      't2',
      { port: 'T2_PORT', secret: 'T2_SECRET' },
      schema,
    );
    try {
      cfg();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.issues.map((i) => i.env).sort()).toEqual([
        'T2_PORT',
        'T2_SECRET',
      ]);
      expect(err.message).not.toContain('too-short');
    }
  });

  it('rejects duplicate namespaces', () => {
    defineConfig('dup', { port: 'D_PORT', secret: 'D_SECRET' }, schema);
    expect(() =>
      defineConfig('dup', { port: 'D_PORT', secret: 'D_SECRET' }, schema),
    ).toThrow(/already registered/);
  });
});
