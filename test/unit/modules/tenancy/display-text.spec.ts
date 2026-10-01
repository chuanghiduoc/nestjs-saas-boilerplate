import { describe, expect, it } from 'vitest';
import {
  oneLine,
  roleLabelOf,
} from '../../../../src/modules/tenancy/domain/display-text.js';

describe('oneLine (email params reject CR/LF and > DISPLAY_NAME_MAX; org/role names may contain them)', () => {
  it.each([
    ['Acme', 10, 'Acme'],
    ['Acme\r\nBcc: x@example.test', 100, 'Acme Bcc: x@example.test'],
    ['A\u2028B\u2029C\nD', 100, 'A B C D'],
    ['  padded  ', 100, 'padded'],
    ['abcdef', 3, 'abc'],
    ['ab😀', 3, 'ab'],
    ['😀😀', 4, '😀😀'],
  ])('%j (max %i) → %j', (input, max, expected) => {
    expect(oneLine(input, max)).toBe(expected);
  });
});

describe('roleLabelOf (role name in an email or a token preview)', () => {
  it('system roles use their fixed label, custom roles their name; a role with neither is a programming error', () => {
    expect(roleLabelOf({ systemKey: 'ADMIN', name: null })).toBe('Admin');
    expect(roleLabelOf({ systemKey: null, name: 'Payroll clerks' })).toBe(
      'Payroll clerks',
    );
    expect(() => roleLabelOf({ systemKey: null, name: null })).toThrow(
      /neither a system key nor a name/,
    );
  });
});
