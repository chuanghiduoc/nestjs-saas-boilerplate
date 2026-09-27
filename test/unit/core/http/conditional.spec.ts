import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import { assertIfMatch, etagOf } from '../../../../src/core/http/index.js';

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
