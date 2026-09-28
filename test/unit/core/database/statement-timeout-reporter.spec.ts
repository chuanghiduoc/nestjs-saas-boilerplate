import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StatementTimeoutReporter } from '../../../../src/core/database/index.js';

const EVENT = 'x_statement_timeout_misconfigured';
const PROBLEM = 'auth_user statement_timeout is 0 (unset)';

function reporter(nodeEnv: string) {
  const logger = new Logger('test');
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { r: new StatementTimeoutReporter(logger, EVENT, nodeEnv), error };
}

describe('StatementTimeoutReporter (shared by the database and auth_database probes)', () => {
  it('no problem: nothing logged, nothing thrown', () => {
    const { r, error } = reporter('production');
    expect(() => r.report(undefined)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
  it('production: logs an error and throws on every probe', () => {
    const { r, error } = reporter('production');
    for (let i = 0; i < 2; i++)
      expect(() => r.report(PROBLEM, { settingMs: 0 })).toThrow(PROBLEM);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      { event: EVENT, settingMs: 0, enforced: true },
      PROBLEM,
    );
  });
  it.each(['development', 'test'])(
    '%s: logs once per reporter, never throws',
    (nodeEnv) => {
      const { r, error } = reporter(nodeEnv);
      for (let i = 0; i < 3; i++) expect(() => r.report(PROBLEM)).not.toThrow();
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        { event: EVENT, enforced: false },
        PROBLEM,
      );
    },
  );
});
