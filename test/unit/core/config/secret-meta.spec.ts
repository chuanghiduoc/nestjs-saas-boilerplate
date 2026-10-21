import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_ROLES,
  appConfig,
  secretFieldsOf,
  secretMeta,
  type ConfigEntry,
} from '../../../../src/core/config/index.js';

const entry = (
  shape: Record<string, z.ZodType>,
  env: Record<string, string>,
): ConfigEntry => ({ namespace: 'x', env, schema: z.object(shape) });

describe('secret metadata on config schemas (spec SP7 S7-D33)', () => {
  it('reads secretMeta through optional, default, nullable and pipe, placed outside or inside the wrapper, sorted by env', () => {
    const fields = secretFieldsOf([
      entry(
        {
          e: z
            .string()
            .nullable()
            .meta(secretMeta(['api'])),
          a: z.string().meta(secretMeta(['worker', 'api'])),
          b: z
            .string()
            .optional()
            .meta(secretMeta(['worker'])),
          c: z
            .string()
            .meta(secretMeta(['migrate']))
            .optional(),
          d: z
            .string()
            .default('')
            .transform((s) => s.split(','))
            .describe('D')
            .meta(secretMeta(['api', 'worker'])),
          plain: z.string().describe('not a secret'),
        },
        {
          a: 'X_A',
          b: 'X_B',
          c: 'X_C',
          d: 'X_D',
          e: 'X_E',
          plain: 'X_PLAIN',
        },
      ),
    ]);
    expect(fields).toEqual([
      { env: 'X_A', roles: ['api', 'worker'] },
      { env: 'X_B', roles: ['worker'] },
      { env: 'X_C', roles: ['migrate'] },
      { env: 'X_D', roles: ['api', 'worker'] },
      { env: 'X_E', roles: ['api'] },
    ]);
  });
  it('keeps the description next to the metadata, in either order', () => {
    expect(
      z
        .string()
        .describe('Pwd')
        .meta(secretMeta(['api'])).description,
    ).toBe('Pwd');
    expect(
      z
        .string()
        .meta(secretMeta(['api']))
        .describe('Pwd')
        .meta(),
    ).toEqual({ secret: { roles: ['api'] }, description: 'Pwd' });
  });
  it('refuses malformed secret metadata by env name, and an empty role list', () => {
    expect(() =>
      secretFieldsOf([
        entry(
          { a: z.string().meta({ secret: { roles: ['admin'] } }) },
          { a: 'X_A' },
        ),
      ]),
    ).toThrow(
      'X_A: .meta({ secret }) must be secretMeta([...]) with roles from api|worker|migrate',
    );
    expect(() => secretMeta([])).toThrow('secretMeta needs at least one role');
  });
  it('APP_ROLES is exactly the enum of APP_ROLE', () => {
    expect(appConfig.schema.shape.role.options).toEqual([...APP_ROLES]);
  });
});
