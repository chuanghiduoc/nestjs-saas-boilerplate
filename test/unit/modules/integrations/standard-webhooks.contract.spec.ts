import { randomBytes } from 'node:crypto';
import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';

/**
 * Spike W1 (spec SP6 §4) giữ thành test hợp đồng: đúng những gì `StandardWebhooksSigner` (Task 7) và test phía người nhận
 * (Task 11, smoke Task 18) dựa vào. `standardwebhooks` 1.1.1 là CommonJS; Node nạp named export qua cjs-module-lexer.
 */
const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const SIGNATURE = /^v1,[A-Za-z0-9+/]+={0,2}$/;
/** Dung sai timestamp cố định của thư viện (`WEBHOOK_TOLERANCE_IN_SECONDS` trong dist/index.js). */
const TOLERANCE_SEC = 5 * 60;
const headersOf = (id: string, at: Date, signature: string) => ({
  'webhook-id': id,
  'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
  'webhook-signature': signature,
});

describe('standardwebhooks 1.1.1 contract (spike W1)', () => {
  it('imports Webhook and WebhookVerificationError from ESM', () => {
    expect(typeof Webhook).toBe('function');
    expect(new WebhookVerificationError('x')).toBeInstanceOf(Error);
  });
  it('sign(msgId, Date, body) is v1,<base64>, deterministic, and accepts the whsec_ prefix or not', () => {
    const s = secret();
    const at = new Date();
    const a = new Webhook(s).sign('evt_1', at, '{"a":1}');
    expect(a).toMatch(SIGNATURE);
    expect(new Webhook(s).sign('evt_1', at, '{"a":1}')).toBe(a);
    expect(
      new Webhook(s.slice('whsec_'.length)).sign('evt_1', at, '{"a":1}'),
    ).toBe(a);
  });
  it('verify accepts two space-separated signatures when it knows only one of the two secrets', () => {
    const [oldS, newS] = [secret(), secret()];
    const at = new Date();
    const body = JSON.stringify({
      type: 'tenancy.org.updated',
      version: 1,
      timestamp: at.toISOString(),
      data: { k: 1 },
    });
    const headers = headersOf(
      'evt_2',
      at,
      [newS, oldS].map((s) => new Webhook(s).sign('evt_2', at, body)).join(' '),
    );
    expect(new Webhook(oldS).verify(body, headers)).toEqual(JSON.parse(body));
    expect(new Webhook(newS).verify(body, headers)).toEqual(JSON.parse(body));
    expect(() => new Webhook(secret()).verify(body, headers)).toThrow(
      WebhookVerificationError,
    );
  });
  it('verify refuses a timestamp outside the tolerance and a changed body', () => {
    const s = secret();
    const old = new Date(Date.now() - (TOLERANCE_SEC + 60) * 1000);
    expect(() =>
      new Webhook(s).verify(
        '{}',
        headersOf('evt_3', old, new Webhook(s).sign('evt_3', old, '{}')),
      ),
    ).toThrow(/too old/);
    const now = new Date();
    expect(() =>
      new Webhook(s).verify(
        '{"x":1}',
        headersOf('evt_3', now, new Webhook(s).sign('evt_3', now, '{}')),
      ),
    ).toThrow(/No matching signature/);
  });
});
