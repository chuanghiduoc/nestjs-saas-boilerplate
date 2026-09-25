import { describe, expect, it } from 'vitest';
import { CTX } from '../../../../src/core/context/index.js';

describe('CTX keys', () => {
  it('are flat (no "." path separator), so nested CLS contexts never share objects', () => {
    for (const key of Object.values(CTX)) expect(key).not.toContain('.');
  });
});
