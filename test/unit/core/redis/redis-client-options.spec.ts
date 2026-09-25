import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  redisClientOptions,
  redisConfig,
} from '../../../../src/core/redis/index.js';

describe('redisClientOptions', () => {
  beforeEach(() => vi.stubEnv('REDIS_URL', 'redis://localhost:6379'));
  afterEach(() => vi.unstubAllEnvs());

  it('non-blocking clients fail fast with no offline queue or resend, so maxRetriesPerRequest has nothing to act on and is not a config knob', () => {
    const cfg = redisConfig();
    expect(Object.keys(cfg).sort()).toEqual([
      'commandTimeoutMs',
      'keyPrefix',
      'url',
    ]);
    expect(redisClientOptions(cfg, false)).toEqual({
      commandTimeout: cfg.commandTimeoutMs,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
  });

  it('blocking clients (BullMQ Worker) keep the offline queue and require maxRetriesPerRequest: null', () => {
    expect(redisClientOptions(redisConfig(), true)).toEqual({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      autoResendUnfulfilledCommands: true,
    });
  });
});
