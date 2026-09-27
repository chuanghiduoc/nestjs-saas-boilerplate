import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';

const base = {
  APP_ROLE: 'worker',
  NODE_ENV: 'development',
  REDIS_URL: 'redis://localhost:6379',
  DB_HOST: 'h',
  DB_NAME: 'n',
  DB_APP_PASSWORD: 'p',
  DB_RELAY_PASSWORD: 'p',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({
    k1: Buffer.alloc(32).toString('base64'),
  }),
  FIELD_ENCRYPTION_ACTIVE_KID: 'k1',
  SMTP_HOST: 'mail.example.test',
  MAIL_FROM: 'App <noreply@example.test>',
};
const stub = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
};

describe('notifications/smtp config rules', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts the defaults on a worker', () => {
    stub({});
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('a worker needs SMTP_HOST and MAIL_FROM; the api does not', () => {
    stub({ SMTP_HOST: '' });
    expect(() => validateAllConfigs()).toThrow(
      /SMTP_HOST and MAIL_FROM are required on the worker/,
    );
    stub({ APP_ROLE: 'api', SMTP_HOST: '', MAIL_FROM: '' });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('the send deadline must be shorter than the claim lease', () => {
    stub({
      SMTP_SEND_DEADLINE_MS: '30000',
      NOTIFICATIONS_CLAIM_LEASE_MS: '20000',
    });
    expect(() => validateAllConfigs()).toThrow(
      /SMTP_SEND_DEADLINE_MS .* must be less than NOTIFICATIONS_CLAIM_LEASE_MS/,
    );
  });
  it('the send deadline must be shorter than the resilience timeout of provider smtp (default and override)', () => {
    stub({
      SMTP_SEND_DEADLINE_MS: '12000',
      RESILIENCE_DEFAULT_TIMEOUT_MS: '10000',
    });
    expect(() => validateAllConfigs()).toThrow(
      /SMTP_SEND_DEADLINE_MS \(12000\) must be less than the resilience timeout of provider "smtp" \(10000/,
    );
    stub({
      SMTP_SEND_DEADLINE_MS: '8000',
      RESILIENCE_OVERRIDES: JSON.stringify({ smtp: { timeoutMs: 5000 } }),
    });
    expect(() => validateAllConfigs()).toThrow(
      /resilience timeout of provider "smtp" \(5000/,
    );
    stub({
      SMTP_SEND_DEADLINE_MS: '8000',
      RESILIENCE_OVERRIDES: JSON.stringify({ smtp: { timeoutMs: 9000 } }),
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('the total job backoff must exceed the claim lease', () => {
    stub({
      QUEUE_DEFAULT_ATTEMPTS: '2',
      QUEUE_DEFAULT_BACKOFF_MS: '1000',
      NOTIFICATIONS_CLAIM_LEASE_MS: '20000',
    });
    expect(() => validateAllConfigs()).toThrow(/total retry backoff/);
  });
  it.each(['EN', 'en_US', 'english', 'e'])('rejects locale %s', (loc) => {
    stub({ NOTIFICATIONS_DEFAULT_LOCALE: loc });
    expect(() => validateAllConfigs()).toThrow(/NOTIFICATIONS_DEFAULT_LOCALE/);
  });
  it('production requires TLS to SMTP with certificate verification', () => {
    stub({
      NODE_ENV: 'production',
      SMTP_SECURE: 'false',
      SMTP_REQUIRE_TLS: 'false',
    });
    expect(() => validateAllConfigs()).toThrow(
      /SMTP_SECURE or SMTP_REQUIRE_TLS/,
    );
    stub({
      NODE_ENV: 'production',
      SMTP_REQUIRE_TLS: 'true',
      SMTP_TLS_REJECT_UNAUTHORIZED: 'false',
    });
    expect(() => validateAllConfigs()).toThrow(/SMTP_TLS_REJECT_UNAUTHORIZED/);
  });
});
