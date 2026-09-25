import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../../../src/core/database/index.js';

describe('escapeLike', () => {
  it('escapes wildcard and escape characters', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });
  it('leaves ordinary text untouched', () => {
    expect(escapeLike("o'brien")).toBe("o'brien");
  });
});
