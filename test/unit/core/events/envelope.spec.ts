import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { z } from 'zod';
import {
  defineEvent,
  parseEnvelope,
} from '../../../../src/core/events/index.js';

const Created = defineEvent({
  type: 'unit.thing.created',
  version: 1,
  schema: z.object({ name: z.string() }),
});

describe('event envelope', () => {
  it('rejects duplicate type@version and bad type names', () => {
    expect(() =>
      defineEvent({
        type: 'unit.thing.created',
        version: 1,
        schema: z.object({}),
      }),
    ).toThrow(/already defined/);
    expect(() =>
      defineEvent({ type: 'BadName', version: 1, schema: z.object({}) }),
    ).toThrow(/context\.aggregate\.verb/);
    for (const version of [0, 1.5])
      expect(() =>
        defineEvent({
          type: 'unit.thing.versioned',
          version,
          schema: z.object({}),
        }),
      ).toThrow(/positive integer/);
  });
  it('validates data against the event schema', () => {
    const base = {
      id: v7(),
      type: Created.type,
      version: 1,
      occurredAt: new Date().toISOString(),
      orgId: null,
      actor: { type: 'system', id: 'test' },
      aggregate: { type: 'thing', id: '1', version: 1 },
      correlationId: v7(),
      causationId: null,
    };
    expect(
      parseEnvelope(Created, { ...base, data: { name: 'x' } }).data.name,
    ).toBe('x');
    expect(() =>
      parseEnvelope(Created, { ...base, data: { name: 1 } }),
    ).toThrow();
  });
  it('rejects an envelope of another type@version or without actor', () => {
    const base = {
      id: v7(),
      type: Created.type,
      version: 1,
      occurredAt: new Date().toISOString(),
      orgId: null,
      actor: { type: 'system', id: 'test' },
      aggregate: { type: 'thing', id: '1', version: 1 },
      correlationId: v7(),
      causationId: null,
      data: { name: 'x' },
    };
    expect(() => parseEnvelope(Created, { ...base, version: 2 })).toThrow(
      /does not match definition unit\.thing\.created@1/,
    );
    const { actor: _actor, ...noActor } = base;
    expect(() => parseEnvelope(Created, noActor)).toThrow(/actor/);
    expect(() =>
      parseEnvelope(Created, { ...base, actor: { type: 'robot', id: 'x' } }),
    ).toThrow(/actor/);
  });
});
