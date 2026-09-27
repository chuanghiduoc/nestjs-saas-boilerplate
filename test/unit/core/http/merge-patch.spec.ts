import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  applyMergePatch,
  mergePatchInto,
  mergePatchSchema,
  type MergePatch,
} from '../../../../src/core/http/index.js';

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
    alias: z.union([z.string(), z.null()]),
    bio: z.string().optional(),
    motto: z.string().nullish(),
    addr: z.object({
      city: z.string(),
      zip: z.string().nullable(),
      note: z.string().optional(),
      geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
      pin: z.object({ code: z.string() }).nullable(),
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

  it('null only where the source field is nullable (spec §SP1-216), at every level', () => {
    for (const ok of [
      { nickname: null },
      { alias: null },
      { motto: null },
      { billing: null },
      { addr: { zip: null } },
      { addr: { pin: null } },
    ])
      expect(Patch.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const [bad, path] of [
      [{ name: null }, 'name'],
      [{ bio: null }, 'bio'],
      [{ addr: null }, 'addr'],
      [{ addr: { city: null } }, 'addr.city'],
      [{ addr: { note: null } }, 'addr.note'],
      [{ addr: { geo: null } }, 'addr.geo'],
      [{ addr: { geo: { lat: null } } }, 'addr.geo.lat'],
    ] as const)
      expect(paths(Patch.safeParse(bad)), JSON.stringify(bad)).toEqual([path]);
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

  it('looks through readonly, nullish and union-with-null wrappers', () => {
    const P = mergePatchSchema(
      z.object({
        a: z.object({ b: z.string(), c: z.string() }).readonly(),
        d: z.object({ e: z.string() }).nullish(),
        f: z.union([z.object({ g: z.string(), h: z.string() }), z.null()]),
      }),
    );
    expect(P.parse({ a: { b: 'x' }, d: null, f: { g: 'y' } })).toEqual({
      a: { b: 'x' },
      d: null,
      f: { g: 'y' },
    });
    expect(P.parse({ f: null })).toEqual({ f: null });
    expect(paths(P.safeParse({ f: { x: 1 } }))).toEqual(['f']);
  });

  it('refuses .default/.prefault/.catch anywhere inside a field', () => {
    for (const [field, path] of [
      [z.object({ role: z.string().default('USER') }), 'role'],
      [
        z.object({
          addr: z.object({ city: z.string().prefault('X') }).optional(),
        }),
        'addr.city',
      ],
      [z.object({ n: z.number().catch(0) }), 'n'],
      [z.object({ a: z.union([z.number().catch(0), z.string()]) }), 'a'],
      [z.object({ a: z.string().pipe(z.string().catch('x')) }), 'a'],
      [z.object({ a: z.array(z.number().catch(0)) }), 'a.*'],
      [z.object({ a: z.record(z.string(), z.number().default(1)) }), 'a.*'],
      [
        z.object({
          a: z.intersection(z.number().catch(0), z.number()).nullable(),
        }),
        'a',
      ],
      [z.object({ a: z.lazy(() => z.number().catch(0)).optional() }), 'a'],
    ] as const)
      expect(() => mergePatchSchema(field)).toThrow(
        new RegExp(
          `"${path.replace(/[.*]/g, '\\$&')}" must not have a default`,
        ),
      );
  });

  it('a bad value is rejected, never silently replaced', () => {
    const P = mergePatchSchema(
      z.object({ a: z.union([z.number(), z.string()]) }),
    );
    expect(paths(P.safeParse({ a: { bad: true } }))).toEqual(['a']);
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
        alias: z.union([z.string(), z.null()]),
        addr: z.object({ city: z.string(), zip: z.string().optional() }),
      }),
    );
    expectTypeOf<z.output<typeof P>>().toEqualTypeOf<{
      name?: string;
      nick?: string | null;
      alias?: string | null;
      addr?: { city?: string; zip?: string };
    }>();
  });
});

describe('applyMergePatch (pure RFC 7396 §2, Appendix A vectors)', () => {
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
    expect(applyMergePatch(target, patch)).toEqual(expected);
    expect(target).toEqual(before);
  });

  it('refuses a "__proto__" member instead of rewriting the prototype', () => {
    const patch: unknown = JSON.parse('{"a":{"__proto__":{"admin":true}}}');
    expect(fieldsOf(() => applyMergePatch({ a: {} }, patch))).toEqual({
      code: 'validation_failed',
      fields: [
        expect.objectContaining({ path: 'a.__proto__', code: 'invalid' }),
      ],
    });
  });

  it('"constructor.prototype" is plain data: no global pollution, inputs unchanged', () => {
    const patch: unknown = JSON.parse(
      '{"constructor":{"prototype":{"polluted":true}},"a":{"constructor":{"prototype":{"polluted":true}}}}',
    );
    const target = { a: { b: 1 } };
    const targetBefore = structuredClone(target);
    const patchBefore = structuredClone(patch);
    const result = applyMergePatch(target, patch);
    expect(result).toEqual({
      constructor: { prototype: { polluted: true } },
      a: { b: 1, constructor: { prototype: { polluted: true } } },
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect({}).not.toHaveProperty('polluted');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(target).toEqual(targetBefore);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(patch).toEqual(patchBefore);
  });
});

describe('mergePatchInto (schema-aware)', () => {
  const Doc = z.object({
    name: z.string(),
    nickname: z.string().nullable(),
    alias: z.union([z.string(), z.null()]),
    bio: z.string().nullish(),
    addr: z.object({ city: z.string(), zip: z.string().nullable() }),
    billing: z.object({ vat: z.string() }).nullable(),
    labels: z.record(z.string(), z.string()),
  });
  const current: z.output<typeof Doc> = {
    name: 'Me',
    nickname: 'me',
    alias: 'm',
    bio: 'hi',
    addr: { city: 'Hanoi', zip: '100000' },
    billing: null,
    labels: { a: '1', b: '2' },
  };

  it('keeps nested members the patch omits; does not mutate the target', () => {
    const before = structuredClone(current);
    expect(mergePatchInto(Doc, current, { addr: { city: 'Hue' } })).toEqual({
      ...current,
      addr: { city: 'Hue', zip: '100000' },
    });
    expect(current).toEqual(before);
  });

  it('null sets a nullable-required member (incl. union with z.null()) to null; removes a nullish one', () => {
    expect(
      mergePatchInto(Doc, current, {
        nickname: null,
        alias: null,
        bio: null,
        addr: { zip: null },
      }),
    ).toEqual({
      name: 'Me',
      nickname: null,
      alias: null,
      addr: { city: 'Hanoi', zip: null },
      billing: null,
      labels: { a: '1', b: '2' },
    });
  });

  it('records merge per entry', () => {
    expect(
      mergePatchInto(Doc, current, { labels: { b: null, c: '3' } }).labels,
    ).toEqual({ a: '1', c: '3' });
  });

  it('drops members outside the schema from the result', () => {
    const stored = { ...current, passwordHash: 'x' };
    expect(mergePatchInto(Doc, stored, { name: 'New' })).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('a patch that leaves the document invalid → 422 with the nested path', () => {
    expect(
      fieldsOf(() => mergePatchInto(Doc, current, { billing: {} })),
    ).toEqual({
      code: 'validation_failed',
      fields: [expect.objectContaining({ path: 'billing.vat' })],
    });
  });

  it('patch parameter is typed by the schema', () => {
    expectTypeOf<
      Parameters<typeof mergePatchInto<typeof Doc>>[2]
    >().toEqualTypeOf<MergePatch<z.output<typeof Doc>>>();
  });
});
