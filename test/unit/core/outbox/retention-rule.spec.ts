import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { outboxConfig } from '../../../../src/core/outbox/outbox.config.js';
import { queueConfig } from '../../../../src/core/queue/queue.config.js';

const DAY_SEC = 86_400;
const check = () => {
  const r = configRuleRegistry().find((x) => x.name === 'outbox-retention');
  if (!r) throw new Error('outbox-retention rule not registered');
  return r.rule({ outbox: outboxConfig(), queue: queueConfig() });
};

describe('outbox retention rule', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults satisfy the invariants', () => {
    expect(check()).toBeUndefined();
  });

  it('rejects outbox retention not above the kept-failed age of jobs', () => {
    vi.stubEnv('OUTBOX_RETENTION_DAYS', '7');
    vi.stubEnv('QUEUE_KEEP_FAILED_AGE_SEC', String(7 * DAY_SEC));
    expect(check()).toMatch(
      /OUTBOX_RETENTION_DAYS .* must be greater than QUEUE_KEEP_FAILED_AGE_SEC/,
    );
  });

  it('rejects inbox retention not above outbox retention + kept-failed age', () => {
    vi.stubEnv('OUTBOX_RETENTION_DAYS', '14');
    vi.stubEnv('QUEUE_KEEP_FAILED_AGE_SEC', String(7 * DAY_SEC));
    vi.stubEnv('INBOX_RETENTION_DAYS', '21');
    expect(check()).toMatch(
      /INBOX_RETENTION_DAYS \(21d\) must be greater than OUTBOX_RETENTION_DAYS \+ QUEUE_KEEP_FAILED_AGE_SEC \(21d\)/,
    );
    vi.stubEnv('INBOX_RETENTION_DAYS', '22');
    expect(check()).toBeUndefined();
  });
});
