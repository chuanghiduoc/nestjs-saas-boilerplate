import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { httpConfig } from '../../../../src/core/http/http.config.js';

const RULE = 'http-body-limit-linger';
/** Mặc định của chính bản Node đang chạy: server của app không đặt `requestTimeout`. */
const nodeRequestTimeoutMs = new Server().requestTimeout;

const check = () => {
  const r = configRuleRegistry().find((x) => x.name === RULE);
  if (!r) throw new Error(`${RULE} rule not registered`);
  return r.rule({ http: httpConfig() });
};

describe('http body limit linger rule', () => {
  it('documents every unread-body response, including the deferred GET/HEAD timer', () => {
    const shape = httpConfig.schema.shape;
    expect(shape.bodyLimitLingerMs.description).toContain('any response');
    expect(shape.bodyLimitLingerMs.description).toContain('GET/HEAD');
    expect(shape.bodyLimitLingerBytes.description).toContain('any response');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('the default linger fits under the Node requestTimeout', () => {
    expect(nodeRequestTimeoutMs).toBeGreaterThan(0);
    expect(check()).toBeUndefined();
  });

  it('rejects a linger that reaches the Node requestTimeout', () => {
    vi.stubEnv('HTTP_BODY_LIMIT_LINGER_MS', String(nodeRequestTimeoutMs));
    expect(check()).toMatch(
      /HTTP_BODY_LIMIT_LINGER_MS .* must be below the Node HTTP server requestTimeout/,
    );
  });
});
