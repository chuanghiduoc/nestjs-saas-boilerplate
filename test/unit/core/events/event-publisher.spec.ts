import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '../../../../src/core/context/index.js';
import {
  EventPublisher,
  defineEvent,
} from '../../../../src/core/events/index.js';
import type { OutboxWriter } from '../../../../src/core/outbox/index.js';

const Hooked = defineEvent({
  type: 'unit.hook.fired',
  version: 1,
  schema: z.object({}),
  audit: true,
  webhook: true,
});
const Plain = defineEvent({
  type: 'unit.plain.fired',
  version: 1,
  schema: z.object({}),
  audit: false,
  webhook: false,
});
const ORG = '0199a000-0000-7000-8000-000000000001';
const input = {
  data: {},
  aggregate: { type: 'unit', id: 'u1', version: 1 },
  actor: { type: 'system' as const, id: 'unit' },
};
function make(orgId: string | undefined) {
  const append = vi.fn(() => Promise.resolve());
  const outbox = { append } as Pick<OutboxWriter, 'append'> as OutboxWriter;
  const ctx = {
    orgId: () => orgId,
    requestId: () => 'req-unit',
    traceparent: () => undefined,
  } as Pick<
    RequestContext,
    'orgId' | 'requestId' | 'traceparent'
  > as RequestContext;
  return { publisher: new EventPublisher(outbox, ctx), append };
}

describe('EventPublisher and the webhook flag (spec SP6 §8.3 fan-out step 1, C-3)', () => {
  it('a webhook event outside an organization is refused before anything is written', async () => {
    const { publisher, append } = make(undefined);
    await expect(publisher.publish(Hooked, input)).rejects.toThrow(
      /unit\.hook\.fired@1" is a webhook event and must be published inside an organization context/,
    );
    expect(append).not.toHaveBeenCalled();
  });
  it('inside an organization a webhook event is written with that org', async () => {
    const { publisher, append } = make(ORG);
    await publisher.publish(Hooked, input);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, type: 'unit.hook.fired' }),
      { ifAbsent: undefined },
    );
  });
  it('an event without the webhook flag may still be published outside any organization', async () => {
    const { publisher, append } = make(undefined);
    await publisher.publish(Plain, input);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null }),
      { ifAbsent: undefined },
    );
  });
});
