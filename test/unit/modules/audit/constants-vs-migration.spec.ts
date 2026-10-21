import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTOR_TYPES } from '../../../../src/core/events/envelope.js';
import {
  AUDIT_PARTITIONS_LOCK_KEY,
  AUDIT_PREMAKE_MAX_MONTHS,
  AUDIT_RETENTION_MAX_MONTHS,
  AUDIT_RETENTION_MIN_MONTHS,
  AUDIT_TEXT_MAX_LENGTH,
} from '../../../../src/modules/audit/constants.js';

/** A-10 (spec SP6 §6.7): migration viết cứng, test so với code. */
const DIR = 'src/migrations/audit';
const file = readdirSync(DIR).find((f) => f.endsWith('_audit_logs.ts'));
const sql = file ? readFileSync(join(DIR, file), 'utf8') : '';

describe('constants hard-coded in the audit_logs migration equal the code (A-10)', () => {
  it('finds the migration', () => {
    expect(file).toBeDefined();
  });
  it('lock key, retention floor and ceiling, premake ceiling', () => {
    expect(sql).toContain(
      `pg_try_advisory_xact_lock(${AUDIT_PARTITIONS_LOCK_KEY})`,
    );
    expect(sql).toContain(
      `p_retention_months < ${AUDIT_RETENTION_MIN_MONTHS} OR p_retention_months > ${AUDIT_RETENTION_MAX_MONTHS}`,
    );
    expect(sql).toContain(
      `p_premake_months < 1 OR p_premake_months > ${AUDIT_PREMAKE_MAX_MONTHS}`,
    );
  });
  it('text bounds (5 columns) and the actor type set', () => {
    expect(
      sql.match(new RegExp(`BETWEEN 1 AND ${AUDIT_TEXT_MAX_LENGTH}\\)`, 'g'))
        ?.length,
    ).toBe(5);
    expect(sql).toContain(
      `actor_type IN (${ACTOR_TYPES.map((t) => `'${t}'`).join(', ')})`,
    );
  });
  it('the partition key keeps millisecond precision (cursor exactness, ruling 6B-1)', () => {
    expect(sql).toContain('recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()');
  });
});
