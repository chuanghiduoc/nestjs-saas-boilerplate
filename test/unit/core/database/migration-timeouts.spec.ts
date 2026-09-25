import { describe, expect, it } from 'vitest';
import { assertMigrationTimeouts } from '../../../../src/core/database/migrator.js';

const expected = { lock_timeout: 5000, statement_timeout: 600000 };
const row = (name: string, setting: string, unit: string | null = 'ms') => ({
  name,
  setting,
  unit,
});

describe('assertMigrationTimeouts', () => {
  it('passes when both timeouts match the configured values', () => {
    expect(() =>
      assertMigrationTimeouts(
        [row('lock_timeout', '5000'), row('statement_timeout', '600000')],
        expected,
      ),
    ).not.toThrow();
  });

  it('throws when a timeout differs (e.g. role default because startup params were dropped)', () => {
    expect(() =>
      assertMigrationTimeouts(
        [row('lock_timeout', '0'), row('statement_timeout', '600000')],
        expected,
      ),
    ).toThrow(/lock_timeout is 0ms, expected 5000ms.*not PgBouncer/);
  });

  it('throws when a setting is missing or reported in another unit', () => {
    expect(() =>
      assertMigrationTimeouts([row('statement_timeout', '600', 's')], expected),
    ).toThrow(/lock_timeout is missing; statement_timeout is 600s/);
  });
});
