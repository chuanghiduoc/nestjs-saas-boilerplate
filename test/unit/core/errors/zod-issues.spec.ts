import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodIssuesToFields } from '../../../../src/core/errors/index.js';

const schema = z.object({
  email: z.email(),
  age: z.number().int().min(18),
  items: z.array(z.object({ quantity: z.number().positive() })),
});

describe('zodIssuesToFields', () => {
  it('uses dot paths with array indices and stable codes', () => {
    const r = schema.safeParse({
      email: 'nope',
      age: 10,
      items: [{ quantity: 1 }, { quantity: -1 }],
    });
    const fields = zodIssuesToFields(r.error!.issues);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email', code: 'invalid_email' }),
        expect.objectContaining({ path: 'age', code: 'too_small' }),
        expect.objectContaining({
          path: 'items.1.quantity',
          code: 'too_small',
        }),
      ]),
    );
  });
  it('accepts Standard Schema path segments and missing codes', () => {
    expect(
      zodIssuesToFields([{ message: 'bad', path: [{ key: 'a' }, 0] }]),
    ).toEqual([{ path: 'a.0', code: 'invalid', message: 'bad' }]);
  });
});
