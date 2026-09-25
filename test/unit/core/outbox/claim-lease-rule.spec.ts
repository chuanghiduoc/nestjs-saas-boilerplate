import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { outboxConfig } from '../../../../src/core/outbox/outbox.config.js';

const check = () => {
  const r = configRuleRegistry().find((x) => x.name === 'outbox-claim-lease');
  if (!r) throw new Error('outbox-claim-lease rule not registered');
  return r.rule({ outbox: outboxConfig() });
};

describe('outbox claim lease rule', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults satisfy the invariant', () => {
    expect(check()).toBeUndefined();
  });

  it('rejects a lease shorter than twice the enqueue timeout', () => {
    vi.stubEnv('OUTBOX_ENQUEUE_TIMEOUT_MS', '5000');
    vi.stubEnv('OUTBOX_CLAIM_LEASE_MS', '9999');
    expect(check()).toMatch(
      /OUTBOX_CLAIM_LEASE_MS \(9999\) must be at least 2 x OUTBOX_ENQUEUE_TIMEOUT_MS \(10000\)/,
    );
    vi.stubEnv('OUTBOX_CLAIM_LEASE_MS', '10000');
    expect(check()).toBeUndefined();
  });

  it('does not require the enqueue timeout to stay below idle_in_transaction_session_timeout', () => {
    vi.stubEnv('OUTBOX_ENQUEUE_TIMEOUT_MS', '60000');
    vi.stubEnv('OUTBOX_CLAIM_LEASE_MS', '120000');
    expect(check()).toBeUndefined();
  });
});
