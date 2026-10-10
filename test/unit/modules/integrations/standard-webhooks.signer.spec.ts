import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { StandardWebhooksSigner } from '../../../../src/modules/integrations/infra/standard-webhooks.signer.js';

const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const headersOf = (id: string, at: Date, signature: string) => ({
  'webhook-id': id,
  'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
  'webhook-signature': signature,
});

describe('StandardWebhooksSigner (spec SP6 §8.3 step 3, W-1..W-3)', () => {
  const signer = new StandardWebhooksSigner();
  it('one secret: the receiver verifies with new Webhook(secret).verify (W-1)', () => {
    const s = secret();
    const at = new Date();
    const body =
      '{"type":"tenancy.org.updated","version":1,"timestamp":"t","data":{}}';
    const sig = signer.sign({
      secrets: [s],
      messageId: 'evt-1',
      timestamp: at,
      body,
    });
    expect(new Webhook(s).verify(body, headersOf('evt-1', at, sig))).toEqual(
      JSON.parse(body),
    );
  });
  it('two secrets during the overlap: two space-separated signatures, each secret verifies alone (W-2)', () => {
    const [a, b] = [secret(), secret()];
    const at = new Date();
    const sig = signer.sign({
      secrets: [a, b],
      messageId: 'evt-2',
      timestamp: at,
      body: '{}',
    });
    expect(sig.split(' ')).toHaveLength(2);
    for (const s of [a, b])
      expect(() =>
        new Webhook(s).verify('{}', headersOf('evt-2', at, sig)),
      ).not.toThrow();
  });
  it('after the overlap only the new secret signs; the old one no longer verifies (W-3)', () => {
    const [oldS, newS] = [secret(), secret()];
    const at = new Date();
    const sig = signer.sign({
      secrets: [newS],
      messageId: 'evt-3',
      timestamp: at,
      body: '{}',
    });
    expect(() =>
      new Webhook(oldS).verify('{}', headersOf('evt-3', at, sig)),
    ).toThrow(/No matching signature/);
  });
  it('refuses to sign with no secret (a delivery never goes out unsigned)', () => {
    expect(() =>
      signer.sign({
        secrets: [],
        messageId: 'evt-4',
        timestamp: new Date(),
        body: '{}',
      }),
    ).toThrow(/at least one/);
  });
});
