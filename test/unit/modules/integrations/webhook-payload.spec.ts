import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_BODY_MAX_BYTES,
  buildWebhookBody,
} from '../../../../src/modules/integrations/domain/webhook-payload.js';

describe('webhook body (spec SP6 §8.3 fan-out step 3)', () => {
  it('serialises { type, version, timestamp, data } exactly once, in that key order', () => {
    expect(
      buildWebhookBody({
        type: 'tenancy.org.updated',
        version: 1,
        timestamp: '2026-10-01T00:00:00.000Z',
        data: { orgId: 'o', changed: ['name'] },
      }),
    ).toEqual({
      kind: 'OK',
      body: '{"type":"tenancy.org.updated","version":1,"timestamp":"2026-10-01T00:00:00.000Z","data":{"orgId":"o","changed":["name"]}}',
    });
  });
  it('measures UTF-8 bytes, not UTF-16 units, against WEBHOOK_BODY_MAX_BYTES', () => {
    const r = buildWebhookBody({
      type: 't.a.b',
      version: 1,
      timestamp: 'x',
      data: { emoji: '😀'.repeat(WEBHOOK_BODY_MAX_BYTES / 4) },
    });
    expect(r.kind).toBe('TOO_LARGE');
    expect(r.kind === 'TOO_LARGE' && r.bytes > WEBHOOK_BODY_MAX_BYTES).toBe(
      true,
    );
  });
});
