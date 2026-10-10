import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
} from '../../../../src/modules/integrations/http/delivery-cursor.js';

const KEY = {
  createdAt: '2026-10-07T01:02:03.456789Z',
  publicId: '0199a000-0000-7000-8000-000000000001',
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('delivery cursor (spec SP6 §9.2, Review Focus 5)', () => {
  it('round-trips the microsecond key', () => {
    expect(decodeDeliveryCursor(encodeDeliveryCursor(KEY))).toEqual(KEY);
  });
  it.each([
    ['not base64url', '%%%'],
    [
      'non-canonical base64url (padding)',
      `${b64(JSON.stringify([KEY.createdAt, KEY.publicId]))}=`,
    ],
    ['not JSON', b64('nope')],
    ['an object, not a pair', b64(JSON.stringify({ a: 1 }))],
    ['a triple', b64(JSON.stringify([KEY.createdAt, KEY.publicId, 1]))],
    [
      'millisecond precision',
      b64(JSON.stringify(['2026-10-07T01:02:03.456Z', KEY.publicId])),
    ],
    [
      'an impossible date',
      b64(JSON.stringify(['2026-02-30T00:00:00.000000Z', KEY.publicId])),
    ],
    ['a non-uuid id', b64(JSON.stringify([KEY.createdAt, '42']))],
  ])('Review Focus 5: %s → 400 invalid_cursor', (_name, raw) => {
    try {
      decodeDeliveryCursor(raw);
      throw new Error('expected invalid_cursor');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err instanceof AppError && err.error.code).toBe('invalid_cursor');
    }
  });
});
