import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FieldCipher,
  FieldCipherError,
} from '../../../../src/core/security/index.js';
import { WebhookSecrets } from '../../../../src/modules/integrations/application/webhook-secrets.js';

const cipher = new FieldCipher(
  { k1: randomBytes(32).toString('base64') },
  'k1',
);
const secrets = new WebhookSecrets(cipher);
const ORG = '0199a000-0000-7000-8000-000000000001';
const SECRET_ID = '0199a000-0000-7000-8000-000000000002';

describe('WebhookSecrets (spec SP6 §6.5, §8.3 step 3, S6-A29)', () => {
  it('generates whsec_ + base64 of 32 random bytes, never twice the same', () => {
    const a = secrets.generate();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice('whsec_'.length), 'base64')).toHaveLength(32);
    expect(secrets.generate()).not.toBe(a);
  });
  it('seal/open round-trips; the token is a FieldCipher token that does not contain the secret', () => {
    const s = secrets.generate();
    const token = secrets.seal(s, { orgId: ORG, secretPublicId: SECRET_ID });
    expect(FieldCipher.isCiphertext(token)).toBe(true);
    expect(token).not.toContain(s.slice('whsec_'.length));
    expect(secrets.open(token, { orgId: ORG, secretPublicId: SECRET_ID })).toBe(
      s,
    );
  });
  it('the ciphertext is bound to its org and secret row (AAD)', () => {
    const token = secrets.seal(secrets.generate(), {
      orgId: ORG,
      secretPublicId: SECRET_ID,
    });
    expect(() =>
      secrets.open(token, { orgId: SECRET_ID, secretPublicId: SECRET_ID }),
    ).toThrow(FieldCipherError);
    expect(() =>
      secrets.open(token, { orgId: ORG, secretPublicId: ORG }),
    ).toThrow(FieldCipherError);
  });
});
