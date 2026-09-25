import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  assertIfMatch,
  etagOf,
  mergePatchSchema,
} from '../../../../src/core/http/index.js';

const code = (fn: () => void) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.error.code : 'other';
  }
};

describe('conditional requests', () => {
  it('etagOf is a weak validator of the version', () => {
    expect(etagOf(7)).toBe('W/"7"');
  });
  it('If-Match matching passes; stale fails; missing required fails', () => {
    expect(code(() => assertIfMatch('W/"7"', 7, { required: true }))).toBe(
      'ok',
    );
    expect(code(() => assertIfMatch('W/"6", "7"', 7, { required: true }))).toBe(
      'ok',
    );
    expect(code(() => assertIfMatch('W/"6"', 7, { required: true }))).toBe(
      'precondition_failed',
    );
    expect(code(() => assertIfMatch(undefined, 7, { required: true }))).toBe(
      'precondition_required',
    );
    expect(code(() => assertIfMatch(undefined, 7, { required: false }))).toBe(
      'ok',
    );
  });
  it('accepts "*" and rejects unquoted, partial or blank tags', () => {
    expect(code(() => assertIfMatch('*', 7, { required: true }))).toBe('ok');
    expect(code(() => assertIfMatch('7', 7, { required: true }))).toBe(
      'precondition_failed',
    );
    expect(code(() => assertIfMatch('W/"77"', 7, { required: true }))).toBe(
      'precondition_failed',
    );
    expect(code(() => assertIfMatch('  ', 7, { required: true }))).toBe(
      'precondition_required',
    );
  });
});

describe('mergePatchSchema', () => {
  const User = z.object({
    name: z.string().min(1),
    nickname: z.string().nullable(),
  });
  const Patch = mergePatchSchema(User);
  it('fields optional; null only where the source field is nullable', () => {
    expect(Patch.parse({})).toEqual({});
    expect(Patch.parse({ nickname: null })).toEqual({ nickname: null });
    expect(Patch.safeParse({ name: null }).success).toBe(false);
  });
  it('validates values and rejects unknown fields', () => {
    expect(Patch.safeParse({ name: '' }).success).toBe(false);
    expect(Patch.safeParse({ role: 'ADMIN' }).success).toBe(false);
  });
  it('refuses source fields with defaults (absent must mean unchanged)', () => {
    expect(() =>
      mergePatchSchema(z.object({ role: z.string().default('USER') })),
    ).toThrow(/"role" must not have a default/);
  });
});
