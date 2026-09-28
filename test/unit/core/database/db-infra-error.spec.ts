import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  isDbInfraError,
  isPreCommitInfraError,
  markPreCommitInfraError,
} from '../../../../src/core/database/db-infra-error.js';

const serverError = (code: string, message: string) =>
  Object.assign(new pg.DatabaseError(message, 0, 'error'), { code });
const plain = (message: string, code?: string) =>
  Object.assign(new Error(message), code ? { code } : {});

/**
 * N4: `isPreCommitInfraError` chỉ đúng cho lỗi ĐÃ được đánh dấu bởi `markPreCommitInfraError` — tức đã ném ra từ
 * `MikroOrmUnitOfWork.run`/`RelayDb.transaction` TRƯỚC khi COMMIT từng được thử. Một lỗi hạ tầng chưa đánh dấu (vd.
 * một câu AUTOCOMMIT chạy ngoài transaction) không chứng minh được gì, nên không được coi là "known pre-commit".
 */
describe('isPreCommitInfraError / markPreCommitInfraError (N4)', () => {
  it('an infra error that was never marked is not pre-commit-proven, even though it is a DB infra error', () => {
    const err = plain('read ECONNRESET', 'ECONNRESET');
    expect(isDbInfraError(err)).toBe(true);
    expect(isPreCommitInfraError(err)).toBe(false);
  });

  it('marking an infra error makes isPreCommitInfraError true', () => {
    const err = serverError('08006', 'connection failure');
    expect(isDbInfraError(err)).toBe(true);
    expect(markPreCommitInfraError(err)).toBe(err);
    expect(isPreCommitInfraError(err)).toBe(true);
  });

  it('marking a "no answer" (no SQLSTATE) infra error also makes it pre-commit-proven: it happened inside an open transaction, which never reached COMMIT regardless of whether the failing statement itself got an answer', () => {
    const err = plain('Query read timeout');
    expect(isDbInfraError(err)).toBe(true);
    markPreCommitInfraError(err);
    expect(isPreCommitInfraError(err)).toBe(true);
  });

  it('marking a non-infra error is harmless: it still is not a pre-commit infra error', () => {
    const err = new Error('not a DB error at all');
    markPreCommitInfraError(err);
    expect(isDbInfraError(err)).toBe(false);
    expect(isPreCommitInfraError(err)).toBe(false);
  });

  it('marking returns the same error instance unchanged (safe to use in `throw committing ? f(err) : markPreCommitInfraError(err)`)', () => {
    const err = serverError('53300', 'too many connections');
    expect(markPreCommitInfraError(err)).toBe(err);
    expect(err.code).toBe('53300');
  });
});
