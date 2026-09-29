import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { paginationConfig } from '../../../../src/core/http/index.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';

const LOCAL = {
  AUTH_MODE: 'local',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  AUTH_BASE_URL: 'http://localhost:3000',
};
const check = () => {
  const r = configRuleRegistry().find(
    (x) => x.name === 'identity-directory-batch-covers-page',
  );
  if (!r) throw new Error('rule not registered');
  return r.rule({ identity: identityConfig(), pagination: paginationConfig() });
};

describe('AUTH_DIRECTORY_BATCH_MAX (spec SP3 §5.2, §13)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to 100, accepts 1..1000 and must cover one page of members', () => {
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    expect(identityConfig().directoryBatchMax).toBe(100);
    expect(check()).toBeUndefined();
    vi.stubEnv('AUTH_DIRECTORY_BATCH_MAX', '1001');
    expect(() => identityConfig()).toThrow(/AUTH_DIRECTORY_BATCH_MAX/);
    vi.stubEnv('AUTH_DIRECTORY_BATCH_MAX', '50');
    expect(check()).toBe(
      'AUTH_DIRECTORY_BATCH_MAX (50) must be at least PAGINATION_MAX_PAGE_SIZE (100)',
    );
  });
});
