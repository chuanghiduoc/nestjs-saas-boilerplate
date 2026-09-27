import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  applyMergePatch,
  mergePatchSchema,
  type MergePatch,
} from '../../../../src/core/http/index.js';
import { mergePatch } from '../../../../src/core/http/merge-patch.js';

const fieldsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError)
      return { code: e.error.code, fields: e.opts.fields };
    throw e;
  }
  throw new Error('expected an AppError');
};

const paths = (r: z.ZodSafeParseResult<unknown>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('mergePatchSchema', () => {
  const User = z.object({
    name: z.string().min(1),
    nickname: z.string().nullable(),
    bio: z.string().optional(),
    addr: z.object({
      city: z.string(),
      zip: z.string().nullable(),
      geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
    }),
    billing: z.object({ vat: z.string() }).nullable(),
    tags: z.array(z.string()),
    labels: z.record(z.string(), z.string()),
  });
  const Patch = mergePatchSchema(User);

  it('every field is optional, at every level', () => {
    expect(Patch.parse({})).toEqual({});
    expect(Patch.parse({ addr: {} })).toEqual({ addr: {} });
    expect(Patch.parse({ addr: { city: 'X' } })).toEqual({
      addr: { city: 'X' },
    });
    expect(Patch.parse({ addr: { geo: { lat: 1 } } })).toEqual({
      addr: { geo: { lat: 1 } },
    });
  });

  it('null only where the source field is nullable or optional', () => {
    for (const ok of [
      { nickname: null },
      { bio: null },
      { billing: null },
      { addr: { zip: null } },
      { addr: { geo: null } },
    ])
      expect(Patch.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    expect(paths(Patch.safeParse({ name: null }))).toEqual(['name']);
    expect(paths(Patch.safeParse({ addr: null }))).toEqual(['addr']);
    expect(paths(Patch.safeParse({ addr: { city: null } }))).toEqual([
      'addr.city',
    ]);
    expect(paths(Patch.safeParse({ addr: { geo: { lat: null } } }))).toEqual([
      'addr.geo.lat',
    ]);
  });

  it('validates values and rejects unknown keys at every level, with the nested path', () => {
    expect(paths(Patch.safeParse({ name: '' }))).toEqual(['name']);
    expect(paths(Patch.safeParse({ role: 'ADMIN' }))).toEqual(['']);
    const nested = Patch.safeParse({ addr: { city: 'X', extra: 1 } });
    expect(nested.success).toBe(false);
    expect(nested.error?.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        path: ['addr'],
        keys: ['extra'],
      }),
    ]);
    expect(
      paths(Patch.safeParse({ addr: { geo: { lat: 1, alt: 2 } } })),
    ).toEqual(['addr.geo']);
  });

  it('arrays are whole values: validated in full, never partial', () => {
    expect(Patch.parse({ tags: ['a'] })).toEqual({ tags: ['a'] });
    expect(paths(Patch.safeParse({ tags: [1] }))).toEqual(['tags.0']);
    expect(paths(Patch.safeParse({ tags: null }))).toEqual(['tags']);
  });

  it('records merge per entry (RFC 7396): any subset of entries, null deletes an entry', () => {
    expect(Patch.parse({ labels: { a: 'x', b: null } })).toEqual({
      labels: { a: 'x', b: null },
    });
    expect(paths(Patch.safeParse({ labels: { a: 1 } }))).toEqual(['labels.a']);
    // Finite key sets make every entry required: model them as z.object.
    expect(() =>
      mergePatchSchema(
        z.object({ s: z.record(z.enum(['a', 'b']), z.number()) }),
      ),
    ).toThrow(/"s" is a record keyed by "enum"/);
    const Nested = mergePatchSchema(
      z.object({
        m: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
      }),
    );
    expect(Nested.parse({ m: { k: { x: 1 } } })).toEqual({
      m: { k: { x: 1 } },
    });
    expect(paths(Nested.safeParse({ m: { k: { z: 1 } } }))).toEqual(['m.k']);
  });

  it('looks through readonly and nullish wrappers', () => {
    const P = mergePatchSchema(
      z.object({
        a: z.object({ b: z.string(), c: z.string() }).readonly(),
        d: z.object({ e: z.string() }).nullish(),
      }),
    );
    expect(P.parse({ a: { b: 'x' }, d: null })).toEqual({
      a: { b: 'x' },
      d: null,
    });
  });

  it('refuses defaults at any depth (absent must mean unchanged)', () => {
    expect(() =>
      mergePatchSchema(z.object({ role: z.string().default('USER') })),
    ).toThrow(/"role" must not have a default/);
    expect(() =>
      mergePatchSchema(
        z.object({
          addr: z.object({ city: z.string().prefault('X') }).optional(),
        }),
      ),
    ).toThrow(/"addr.city" must not have a default/);
    expect(() =>
      mergePatchSchema(z.object({ n: z.number().catch(0) })),
    ).toThrow(/"n" must not have a default/);
  });

  it('refuses ambiguous object shapes at build time', () => {
    for (const [field, kind] of [
      [z.union([z.string(), z.object({ city: z.string() })]), 'union'],
      [
        z.discriminatedUnion('t', [
          z.object({ t: z.literal('a') }),
          z.object({ t: z.literal('b') }),
        ]),
        'union',
      ],
      [
        z.intersection(
          z.object({ a: z.string() }),
          z.object({ b: z.string() }),
        ),
        'intersection',
      ],
      [z.object({ a: z.string() }).transform((o) => o.a), 'pipe'],
      [z.lazy(() => z.object({ a: z.string() })), 'lazy'],
    ] as const)
      expect(() =>
        mergePatchSchema(z.object({ x: z.object({ y: field }) })),
      ).toThrow(new RegExp(`"x\\.y" accepts a JSON object through a ${kind}`));
    expect(() =>
      mergePatchSchema(
        z.object({
          s: z.union([z.string(), z.number()]),
          u: z.unknown(),
          l: z.lazy(() => z.string()),
          t: z.string().transform((v) => v.trim()),
        }),
      ),
    ).not.toThrow();
  });

  it('output type is the recursive merge patch of the source', () => {
    const P = mergePatchSchema(
      z.object({
        name: z.string(),
        nick: z.string().nullable(),
        addr: z.object({ city: z.string(), zip: z.string().optional() }),
      }),
    );
    expectTypeOf<z.output<typeof P>>().toEqualTypeOf<{
      name?: string;
      nick?: string | null;
      addr?: { city?: string; zip?: string | null };
    }>();
  });
});

describe('mergePatch (RFC 7396 §2 algorithm, Appendix A vectors)', () => {
  it.each([
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [
      ['a', 'b'],
      ['c', 'd'],
      ['c', 'd'],
    ],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ])('A.%# %j + %j = %j', (target, patch, expected) => {
    const before = structuredClone(target);
    expect(mergePatch(target, patch)).toEqual(expected);
    expect(target).toEqual(before);
  });

  it('refuses a "__proto__" member instead of rewriting the prototype', () => {
    const patch: unknown = JSON.parse('{"a":{"__proto__":{"admin":true}}}');
    expect(fieldsOf(() => mergePatch({ a: {} }, patch))).toEqual({
      code: 'validation_failed',
      fields: [
        expect.objectContaining({ path: 'a.__proto__', code: 'invalid' }),
      ],
    });
  });
});

describe('applyMergePatch', () => {
  const Doc = z.object({
    name: z.string(),
    nickname: z.string().nullable(),
    bio: z.string().optional(),
    addr: z.object({ city: z.string(), zip: z.string().nullable() }),
    billing: z.object({ vat: z.string() }).nullable(),
    labels: z.record(z.string(), z.string()),
  });
  const current: z.output<typeof Doc> = {
    name: 'Me',
    nickname: 'me',
    bio: 'hi',
    addr: { city: 'Hanoi', zip: '100000' },
    billing: null,
    labels: { a: '1', b: '2' },
  };

  it('keeps nested members the patch omits; does not mutate the target', () => {
    const before = structuredClone(current);
    expect(applyMergePatch(Doc, current, { addr: { city: 'Hue' } })).toEqual({
      ...current,
      addr: { city: 'Hue', zip: '100000' },
    });
    expect(current).toEqual(before);
  });

  it('null clears a nullable member and removes an optional one', () => {
    expect(
      applyMergePatch(Doc, current, {
        nickname: null,
        bio: null,
        addr: { zip: null },
      }),
    ).toEqual({
      name: 'Me',
      nickname: null,
      addr: { city: 'Hanoi', zip: null },
      billing: null,
      labels: { a: '1', b: '2' },
    });
  });

  it('records merge per entry', () => {
    expect(
      applyMergePatch(Doc, current, { labels: { b: null, c: '3' } }).labels,
    ).toEqual({ a: '1', c: '3' });
  });

  it('drops members outside the schema from the result', () => {
    const stored = { ...current, passwordHash: 'x' };
    expect(applyMergePatch(Doc, stored, { name: 'New' })).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('a patch that leaves the document invalid → 422 with the nested path', () => {
    expect(
      fieldsOf(() => applyMergePatch(Doc, current, { billing: {} })),
    ).toEqual({
      code: 'validation_failed',
      fields: [expect.objectContaining({ path: 'billing.vat' })],
    });
  });

  it('patch parameter is typed by the schema', () => {
    expectTypeOf<
      Parameters<typeof applyMergePatch<typeof Doc>>[2]
    >().toEqualTypeOf<MergePatch<z.output<typeof Doc>>>();
  });
});
