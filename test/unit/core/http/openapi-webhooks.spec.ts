import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../../../../src/core/events/index.js';
import { webhookDocs } from '../../../../src/core/http/openapi.js';

const Hooked = defineEvent({
  type: 'fixturewh.thing.happened',
  version: 2,
  schema: z.object({ thingId: z.uuid() }),
  audit: false,
  webhook: true,
});
const Quiet = defineEvent({
  type: 'fixturewh.thing.hidden',
  version: 1,
  schema: z.object({ x: z.string() }),
  audit: false,
  webhook: false,
});

describe('OpenAPI 3.1 webhooks section (spec SP6 §8.3 "Hợp đồng công khai", S6-A36)', () => {
  const { webhooks } = webhookDocs([Hooked, Quiet]);
  it('one entry per webhook:true event keyed <type>@<version>; webhook:false events are absent', () => {
    expect(Object.keys(webhooks)).toEqual(['fixturewh.thing.happened@2']);
  });
  it('POST with the three Standard Webhooks headers and the envelope { type, version, timestamp, data } as the body', () => {
    const post = webhooks['fixturewh.thing.happened@2']?.post;
    expect(post?.parameters?.map((p) => ('name' in p ? p.name : ''))).toEqual([
      'webhook-id',
      'webhook-timestamp',
      'webhook-signature',
    ]);
    const body = post?.requestBody;
    const schema =
      body && 'content' in body
        ? body.content['application/json']?.schema
        : undefined;
    expect(schema).toMatchObject({
      type: 'object',
      required: ['type', 'version', 'timestamp', 'data'],
      properties: {
        type: { const: 'fixturewh.thing.happened' },
        version: { const: 2 },
        data: { type: 'object', required: ['thingId'] },
      },
    });
  });
});
