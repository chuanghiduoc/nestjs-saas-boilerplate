import { describe, expect, it } from 'vitest';
import { statementTimeoutProblem } from '../../../../src/modules/identity/infra/better-auth/auth-readiness.js';

describe('statementTimeoutProblem (S2-R60 review M4)', () => {
  it('accepts a role statement_timeout strictly below DB_AUTH_QUERY_TIMEOUT_MS', () => {
    expect(statementTimeoutProblem(5000, 6000)).toBeUndefined();
    expect(statementTimeoutProblem(5999, 6000)).toBeUndefined();
  });
  it('rejects 0 (unset): the server never cancels, so a query the client gave up on keeps its locks', () => {
    expect(statementTimeoutProblem(0, 6000)).toMatch(/is 0 \(unset\)/);
  });
  it('rejects a value at or above the client deadline', () => {
    expect(statementTimeoutProblem(6000, 6000)).toMatch(
      /\(6000 ms\) must be below DB_AUTH_QUERY_TIMEOUT_MS \(6000 ms\)/,
    );
    expect(statementTimeoutProblem(60_000, 6000)).toMatch(/must be below/);
  });
  it('rejects an unreadable setting', () => {
    expect(statementTimeoutProblem(Number.NaN, 6000)).toMatch(
      /could not be read/,
    );
    expect(statementTimeoutProblem(-1, 6000)).toMatch(/could not be read/);
  });
});
