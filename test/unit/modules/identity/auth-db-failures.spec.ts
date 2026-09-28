import { APIError } from 'better-auth/api';
import { CompiledQuery } from 'kysely';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  authDbQueryLog,
  recordAuthApiError,
  recordedAuthDbError,
  recordedAuthDbFailure,
  runWithAuthDbFailureScope,
} from '../../../../src/modules/identity/infra/better-auth/auth-db-failures.js';
import {
  isAuthInfraError,
  isPgClientInfraError,
} from '../../../../src/modules/identity/infra/better-auth/auth-error.mapper.js';

const pgError = (code: string): pg.DatabaseError => {
  const e = new pg.DatabaseError('server said no', 0, 'error');
  e.code = code;
  return e;
};
const kyselyError = (error: unknown) =>
  authDbQueryLog({
    level: 'error',
    error,
    query: CompiledQuery.raw('select 1'),
    queryDurationMillis: 1,
  });
const inScope = <T>(fn: () => T) => runWithAuthDbFailureScope(async () => fn());

describe('pg termination messages are infrastructure errors (S2-R65 review M5)', () => {
  it.each([
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
    'Connection terminated',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'Query read timeout',
    'timeout exceeded when trying to connect',
  ])('%j', (message) => {
    expect(isAuthInfraError(new Error(message))).toBe(true);
    expect(isPgClientInfraError(new Error(message))).toBe(true);
  });
  it('only a plain Error carries the pg origin; subclasses, socket codes and other messages do not', () => {
    class DriverException extends Error {}
    expect(
      isPgClientInfraError(new DriverException('Query read timeout')),
    ).toBe(false);
    expect(
      isPgClientInfraError(
        Object.assign(new Error('read'), { code: 'ECONNRESET' }),
      ),
    ).toBe(false);
    expect(isPgClientInfraError(new Error('Connection is closed.'))).toBe(
      false,
    );
  });
});

describe('per-call auth DB failure scope', () => {
  it('records an infra-class Kysely error as the failure and every DB error for the fail-loud log', async () => {
    expect(
      await inScope(() => {
        kyselyError(pgError('42501'));
        return [recordedAuthDbFailure(), recordedAuthDbError()];
      }),
    ).toEqual([undefined, { errorClass: 'DatabaseError', code: '42501' }]);
    expect(
      await inScope(() => {
        kyselyError(pgError('57014'));
        return recordedAuthDbFailure();
      }),
    ).toEqual({ errorClass: 'DatabaseError', code: '57014' });
  });

  it('M2: onApiError counts only pg-shaped errors as auth pool failures; Redis/app-DB/socket errors do not set dbFailure', async () => {
    class DriverException extends Error {}
    for (const foreign of [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('Connection is closed.'),
      new DriverException('Query read timeout'),
    ])
      expect(
        await inScope(() => {
          recordAuthApiError(foreign);
          return [recordedAuthDbFailure(), recordedAuthDbError()];
        }),
      ).toEqual([undefined, undefined]);
    expect(
      await inScope(() => {
        recordAuthApiError(pgError('57014'));
        return recordedAuthDbFailure();
      }),
    ).toEqual({ errorClass: 'DatabaseError', code: '57014' });
    expect(
      await inScope(() => {
        recordAuthApiError(new Error('Query read timeout'));
        return recordedAuthDbFailure();
      }),
    ).toEqual({ errorClass: 'Error' });
  });

  it('M1: once an unexplained (non-pool, non-APIError) error is seen, a recorded failure no longer explains a 500', async () => {
    expect(
      await inScope(() => {
        kyselyError(pgError('57014'));
        recordAuthApiError(new TypeError('bug'));
        return recordedAuthDbFailure();
      }),
    ).toBeUndefined();
    // Chính APIError là kết quả, không phải nguyên nhân: không làm mất lỗi đã ghi.
    expect(
      await inScope(() => {
        kyselyError(pgError('57014'));
        recordAuthApiError(new APIError('INTERNAL_SERVER_ERROR'));
        return recordedAuthDbFailure();
      }),
    ).toEqual({ errorClass: 'DatabaseError', code: '57014' });
  });

  it('records nothing outside a scope, and scopes never share state', async () => {
    kyselyError(pgError('57014'));
    expect(recordedAuthDbFailure()).toBeUndefined();
    const [a, b] = await Promise.all([
      inScope(async () => {
        kyselyError(pgError('57014'));
        await new Promise((r) => setTimeout(r, 20));
        return recordedAuthDbFailure();
      }),
      inScope(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return recordedAuthDbFailure();
      }),
    ]);
    expect([a, b]).toEqual([
      { errorClass: 'DatabaseError', code: '57014' },
      undefined,
    ]);
  });
});
