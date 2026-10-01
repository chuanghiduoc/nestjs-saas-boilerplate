import { describe, expect, it } from 'vitest';
import {
  loadedModules,
  markModuleLoaded,
} from '../../../../src/core/config/index.js';

describe('module registry (spec SP7 §6.2 bước 4, C1)', () => {
  it('records each module once and returns a copy', () => {
    markModuleLoaded('mr-alpha');
    markModuleLoaded('mr-alpha');
    const first = loadedModules();
    expect([...first].filter((k) => k === 'mr-alpha')).toEqual(['mr-alpha']);
    markModuleLoaded('mr-beta');
    expect(first.has('mr-beta')).toBe(false);
    expect(loadedModules().has('mr-beta')).toBe(true);
  });
  it.each(['', 'Identity', '1files', 'files.x', 'a'.repeat(64)])(
    'rejects the malformed key %j',
    (key) => {
      expect(() => markModuleLoaded(key)).toThrow(/must match/);
    },
  );
});
