import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'src/scripts/gen-env-example.ts';

describe('gen-env-example reads the composition, never a module directly (spec SP7 §6.2, C2 of SP2 §5.15, UP-12b)', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  it('imports nothing under src/modules/ (a disabled module must not reach .env.example)', () => {
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"]\.\.\/modules\//);
  });
  it('imports the project composition', () => {
    expect(source).toContain("import '../app.modules.js';");
  });
});
