import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorClass } from '../../../../src/modules/identity/identity-telemetry.js';

const IDENTITY_SRC = 'src/modules/identity';
const TELEMETRY_FILE = join(IDENTITY_SRC, 'identity-telemetry.ts');
/** The inline form each former copy used; only `identity-telemetry.ts` may keep it (Task 33 parked minor). */
const INLINE_ERROR_CLASS =
  /instanceof Error \? \w+\.constructor\.name : typeof/;

class InvalidThing extends Error {
  override name = 'SomethingElse';
}

describe('errorClass (one implementation for the identity module)', () => {
  it('is the class name, never the assignable `name`; typeof for non-Error throws', () => {
    expect(errorClass(new InvalidThing('secret@example.test'))).toBe(
      'InvalidThing',
    );
    expect(errorClass('boom')).toBe('string');
    expect(errorClass(undefined)).toBe('undefined');
  });
  it('no other file of the identity module re-implements it', () => {
    const copies = readdirSync(IDENTITY_SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(IDENTITY_SRC, f))
      .filter((f) => f !== TELEMETRY_FILE)
      .filter((f) => INLINE_ERROR_CLASS.test(readFileSync(f, 'utf8')));
    expect(copies).toEqual([]);
  });
});
