import { DriverException } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { commitFailure } from '../../../../src/core/database/db-errors.js';
import { dbErrorMapper } from '../../../../src/core/database/index.js';
import { toAppError } from '../../../../src/core/errors/index.js';

/**
 * Final review I1 / M3: which COMMIT failures prove the transaction was NOT applied (keep the original error), and which
 * leave the outcome unknown (`commit_outcome_unknown`).
 */
const serverError = (code: string, message: string, severity = 'ERROR') =>
  Object.assign(new pg.DatabaseError(message, 0, 'error'), { code, severity });
const plain = (message: string, code?: string) =>
  Object.assign(new Error(message), code ? { code } : {});

const logger = () => {
  const l = new Logger('test');
  const error = vi.spyOn(l, 'error').mockImplementation(() => undefined);
  return { l, error };
};

describe('commitFailure (final review I1, M3)', () => {
  it.each([
    [
      '40001 serialization_failure',
      serverError('40001', 'could not serialize'),
    ],
    ['40P01 deadlock_detected', serverError('40P01', 'deadlock detected')],
    [
      '23505 deferred unique_violation',
      serverError('23505', 'duplicate key value'),
    ],
    [
      '23503 deferred foreign_key_violation',
      serverError('23503', 'violates foreign key constraint'),
    ],
    [
      '25P03 idle_in_transaction_session_timeout',
      serverError(
        '25P03',
        'terminating connection due to idle-in-transaction timeout',
        'FATAL',
      ),
    ],
    [
      '25P04 transaction_timeout',
      serverError(
        '25P04',
        'terminating connection due to transaction timeout',
        'FATAL',
      ),
    ],
  ])(
    'a server answer that proves a rollback (%s) keeps the original error',
    (_name, err) => {
      const { l, error } = logger();
      for (const e of [err, new DriverException(err)])
        expect(commitFailure(e, l)).toBe(e);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'PgBouncer "server conn crashed?" (08P01, synthesised by the pooler)',
      serverError('08P01', 'server conn crashed?', 'FATAL'),
    ],
    [
      '57P01 admin_shutdown (can follow a locally committed sync-rep wait)',
      serverError(
        '57P01',
        'terminating connection due to administrator command',
        'FATAL',
      ),
    ],
    ['57P02 crash_shutdown', serverError('57P02', 'crash shutdown', 'FATAL')],
    ['57014 query_canceled', serverError('57014', 'canceling statement')],
    ['53100 disk_full', serverError('53100', 'could not extend file')],
    ['XX000 internal_error', serverError('XX000', 'internal error')],
    [
      // N5: proxies/compat layers use 40003 for "ambiguous result", never PG core; must NOT count as proven rollback.
      '40003 statement_completion_unknown (compat-layer "unknown", not PG core)',
      serverError('40003', 'statement completion unknown'),
    ],
    ['socket reset', plain('read ECONNRESET', 'ECONNRESET')],
    ['pg deadline', plain('Query read timeout')],
    ['socket drop', plain('Connection terminated unexpectedly')],
    ['not a DB error at all', new TypeError('boom')],
  ])('%s → 503 commit_outcome_unknown, logged at ERROR', (_name, err) => {
    const { l, error } = logger();
    const out = commitFailure(err, l);
    expect(toAppError(out).error).toMatchObject({
      code: 'commit_outcome_unknown',
      status: 503,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'commit_outcome_unknown' }),
      expect.any(String),
    );
  });

  it('PgBouncer 08P01 at COMMIT is never reported as a plain service_unavailable', () => {
    const { l } = logger();
    const err = serverError('08P01', 'server conn crashed?', 'FATAL');
    // Outside COMMIT the same error is a plain 503 (nothing written).
    expect(dbErrorMapper(err)?.error.code).toBe('service_unavailable');
    expect(toAppError(commitFailure(err, l)).error.code).toBe(
      'commit_outcome_unknown',
    );
  });

  it.each([
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])(
    'M3: "%s" means pg never sent COMMIT: a known non-commit, plain 503',
    (message) => {
      const { l, error } = logger();
      const err = plain(message);
      const out = commitFailure(err, l);
      expect(out).toBe(err);
      expect(dbErrorMapper(out)?.error.code).toBe('service_unavailable');
      expect(error).not.toHaveBeenCalled();
    },
  );
});
