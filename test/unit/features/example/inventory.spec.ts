import { describe, expect, it } from 'vitest';
import { FEATURE_INVENTORIES } from '../../../support/feature-inventory.js';

describe('the sample inventory is found by the boilerplate glob (S7-D28)', () => {
  it('FEATURE_INVENTORIES holds features/example/example.inventory.ts', () => {
    expect(
      Object.keys(FEATURE_INVENTORIES).some((f) =>
        f.endsWith('features/example/example.inventory.ts'),
      ),
    ).toBe(true);
  });
});
