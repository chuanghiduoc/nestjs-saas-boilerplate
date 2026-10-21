import { describe, expect, it } from 'vitest';
import {
  assertClientCheckInterval,
  assertMigrationTimeouts,
} from '../../../../src/core/database/migrator.js';

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

describe('assertClientCheckInterval (spec SP7 §6.5, review I2)', () => {
  it('passes when the session carries the configured interval', () => {
    expect(() =>
      assertClientCheckInterval(
        row('client_connection_check_interval', '10000'),
      ),
    ).not.toThrow();
  });
  it('throws when the startup option was dropped (interval 0)', () => {
    expect(() =>
      assertClientCheckInterval(row('client_connection_check_interval', '0')),
    ).toThrow(/client_connection_check_interval is 0ms, expected 10000ms/);
  });
  it('throws when the setting is missing', () => {
    expect(() => assertClientCheckInterval(undefined)).toThrow(
      /client_connection_check_interval is missing/,
    );
  });
});
