import { describe, expect, it } from 'vitest';
import {
  PG,
  dbErrorMapper,
  isRetryableTxError,
} from '../../../../src/core/database/db-error.mapper.js';

/** Giống lỗi `DatabaseError` của pg (lỗi lúc COMMIT không được MikroORM convert). */
const pgError = (fields: Record<string, string>, message = 'db error') =>
  Object.assign(new Error(message), fields);

describe('dbErrorMapper / isRetryableTxError', () => {
  it('retries serialization failures and deadlocks, including raw pg errors and wrapped causes', () => {
    expect(
      isRetryableTxError(pgError({ code: PG.SERIALIZATION_FAILURE })),
    ).toBe(true);
    expect(isRetryableTxError(pgError({ code: PG.DEADLOCK_DETECTED }))).toBe(
      true,
    );
    expect(
      isRetryableTxError(
        new Error('wrapped', {
          cause: pgError({ code: PG.SERIALIZATION_FAILURE }),
        }),
      ),
    ).toBe(true);
    expect(isRetryableTxError(pgError({ code: PG.UNIQUE_VIOLATION }))).toBe(
      false,
    );
  });

  it('ignores errors whose code is not a SQLSTATE (e.g. network errors) and non-errors', () => {
    expect(dbErrorMapper(pgError({ code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(dbErrorMapper({ code: PG.UNIQUE_VIOLATION })).toBeUndefined();
    expect(isRetryableTxError('40001')).toBe(false);
  });

  it('maps 42501 to not_found only for row level security violations', () => {
    expect(
      dbErrorMapper(
        pgError(
          { code: PG.INSUFFICIENT_PRIVILEGE },
          'permission denied for table t',
        ),
      ),
    ).toBeUndefined();
    expect(
      dbErrorMapper(
        pgError(
          { code: PG.INSUFFICIENT_PRIVILEGE, routine: 'ExecWithCheckOptions' },
          'localized message',
        ),
      )?.error.code,
    ).toBe('not_found');
  });

  it('leaves unknown SQLSTATEs (e.g. raise_exception from app_current_org) unmapped', () => {
    expect(
      dbErrorMapper(pgError({ code: 'P0001' }, 'org context is not set')),
    ).toBeUndefined();
  });
});
