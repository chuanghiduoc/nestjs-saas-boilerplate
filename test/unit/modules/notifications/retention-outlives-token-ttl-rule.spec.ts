import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
// N7 + SP7 7A: luật chéo module đăng ký qua composition, chỉ khi cả identity lẫn notifications bật.
import { registerCompositionRules } from '../../../../src/composition.config.js';
import { notificationsConfig } from '../../../../src/modules/notifications/notifications.config.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';

registerCompositionRules(new Set(['identity', 'notifications']));

const DAY_SEC = 86_400;
// identityConfig() requires these two when AUTH_MODE is local/hybrid (default: local).
const baseEnv = {
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  AUTH_BASE_URL: 'https://auth.example.test',
};
const stub = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries({ ...baseEnv, ...env })) vi.stubEnv(k, v);
};
const check = () => {
  const r = configRuleRegistry().find(
    (x) => x.name === 'notifications-retention-outlives-token-ttl',
  );
  if (!r)
    throw new Error(
      'notifications-retention-outlives-token-ttl rule not registered',
    );
  return r.rule({
    notifications: notificationsConfig(),
    identity: identityConfig(),
  });
};

describe('notifications retention outlives token ttl rule (final review M2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults satisfy the invariant (30d retention outlives the 1d/1h token TTLs)', () => {
    stub({});
    expect(check()).toBeUndefined();
  });

  it('rejects retention that does not outlive AUTH_EMAIL_TOKEN_TTL_SEC', () => {
    stub({
      NOTIFICATIONS_RETENTION_DAYS: '1',
      AUTH_EMAIL_TOKEN_TTL_SEC: String(7 * DAY_SEC),
    });
    expect(check()).toMatch(
      /NOTIFICATIONS_RETENTION_DAYS \(1d = 86400s\) must be greater than the longest auth token TTL \(AUTH_EMAIL_TOKEN_TTL_SEC\/AUTH_RESET_TOKEN_TTL_SEC, 604800s\)/,
    );
  });

  it('rejects retention that does not outlive AUTH_RESET_TOKEN_TTL_SEC', () => {
    stub({
      NOTIFICATIONS_RETENTION_DAYS: '1',
      AUTH_RESET_TOKEN_TTL_SEC: String(2 * DAY_SEC),
    });
    expect(check()).toMatch(/must be greater than the longest auth token TTL/);
  });

  it('rejects retention exactly equal to the longest TTL (strictly greater is required)', () => {
    stub({
      NOTIFICATIONS_RETENTION_DAYS: '1',
      AUTH_EMAIL_TOKEN_TTL_SEC: String(DAY_SEC),
    });
    expect(check()).toMatch(/must be greater than/);
  });

  it('accepts retention strictly greater than the longest of both token TTLs', () => {
    stub({
      NOTIFICATIONS_RETENTION_DAYS: '2',
      AUTH_EMAIL_TOKEN_TTL_SEC: String(DAY_SEC),
      AUTH_RESET_TOKEN_TTL_SEC: '3600',
    });
    expect(check()).toBeUndefined();
  });
});
