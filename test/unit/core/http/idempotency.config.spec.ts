import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  idempotencyConfig,
  throttleConfig,
} from '../../../../src/core/http/index.js';

describe('idempotencyConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('never allows Set-Cookie in the replay header allowlist', () => {
    vi.stubEnv('IDEMPOTENCY_REPLAY_HEADERS', 'location, Set-Cookie');
    expect(() => idempotencyConfig()).toThrow(/set-cookie/i);
  });

  it('enforces a minimum key length of at least 16', () => {
    vi.stubEnv('IDEMPOTENCY_KEY_MIN_LENGTH', '8');
    expect(() => idempotencyConfig()).toThrow(/IDEMPOTENCY_KEY_MIN_LENGTH/);
  });

  it('requires the maximum key length to be >= the minimum', () => {
    vi.stubEnv('IDEMPOTENCY_KEY_MIN_LENGTH', '64');
    vi.stubEnv('IDEMPOTENCY_KEY_MAX_LENGTH', '32');
    expect(() => idempotencyConfig()).toThrow(/IDEMPOTENCY_KEY_MAX_LENGTH/);
  });

  it('normalizes the replay header allowlist to lowercase names', () => {
    vi.stubEnv('IDEMPOTENCY_REPLAY_HEADERS', ' Location ,ETag,');
    expect(idempotencyConfig().replayHeaders).toEqual(['location', 'etag']);
  });

  it('has defaults for every field', () => {
    expect(idempotencyConfig()).toEqual({
      ttlSec: 86400,
      keyMinLength: 16,
      keyMaxLength: 255,
      replayHeaders: ['location', 'etag'],
    });
  });
});

describe('throttleConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('has defaults and rejects non-positive values', () => {
    expect(throttleConfig()).toEqual({ limit: 300, ttlMs: 60000 });
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', '0');
    expect(() => throttleConfig()).toThrow(/THROTTLE_DEFAULT_LIMIT/);
  });

  it('refuses a window that is not a whole number of seconds (rate-limiter-flexible counts in seconds)', () => {
    vi.stubEnv('THROTTLE_DEFAULT_TTL_MS', '1500');
    expect(() => throttleConfig()).toThrow(/THROTTLE_DEFAULT_TTL_MS/);
  });
});
