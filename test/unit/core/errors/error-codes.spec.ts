import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  CoreErrors,
  allErrorCodes,
  defineErrorCodes,
  findErrorCode,
} from '../../../../src/core/errors/index.js';

describe('error code registry', () => {
  it('derives lowercase snake_case codes from keys', () => {
    expect(CoreErrors.VALIDATION_FAILED).toEqual({
      code: 'validation_failed',
      status: 422,
      title: 'Validation failed',
    });
    expect(findErrorCode('invalid_cursor')).toBe(CoreErrors.INVALID_CURSOR);
  });
  it('rejects a code that is already defined', () => {
    expect(() =>
      defineErrorCodes({
        NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'dup' },
      }),
    ).toThrow(/already defined/);
  });
  it('rejects keys that are not UPPER_SNAKE and non-error statuses', () => {
    expect(() =>
      defineErrorCodes({
        badKey: { status: HttpStatus.BAD_REQUEST, title: 'x' },
      }),
    ).toThrow(/UPPER_SNAKE/);
    expect(() =>
      defineErrorCodes({ WEIRD_OK: { status: HttpStatus.OK, title: 'x' } }),
    ).toThrow(/4xx or 5xx/);
  });
  it('every core code is unique', () => {
    const codes = allErrorCodes().map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
