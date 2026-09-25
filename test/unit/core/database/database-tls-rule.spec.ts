import { describe, expect, it } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import '../../../../src/core/database/database.config.js';

const check = (sslMode: string) => {
  const r = productionRuleRegistry().find((x) => x.name === 'database-tls');
  if (!r) throw new Error('database-tls rule not registered');
  return r.rule({ database: { sslMode } });
};

describe('database-tls production rule', () => {
  it('accepts verify-full (certificate verified, rejectUnauthorized: true)', () => {
    expect(check('verify-full')).toBeUndefined();
  });

  it.each(['disable', 'require'])('rejects DB_SSL_MODE=%s', (mode) => {
    expect(check(mode)).toMatch(
      /DB_SSL_MODE must be verify-full in production/,
    );
  });
});
