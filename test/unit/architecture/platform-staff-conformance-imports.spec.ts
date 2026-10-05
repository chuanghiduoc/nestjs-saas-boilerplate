import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** PSA-9 (addendum A7): file conformance chỉ import `test/support/*`, thư viện, và `index.ts` của module. */
describe('platform-staff-action.conformance.ts imports', () => {
  it('imports only test support, libraries and a module index', () => {
    const src = readFileSync(
      'test/support/platform-staff-action.conformance.ts',
      'utf8',
    );
    const relative = [...src.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
    expect(relative.length, 'the file imports test support').toBeGreaterThan(0);
    for (const path of relative)
      expect(
        /^\.\/[a-z-]+\.js$/.test(path ?? '') ||
          /^\.\.\/\.\.\/src\/modules\/[a-z-]+\/index\.js$/.test(path ?? ''),
        path,
      ).toBe(true);
  });
});
