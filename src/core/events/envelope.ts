import { z } from 'zod';
import type { EventDef } from './event-definition.js';

export const ACTOR_TYPES = ['user', 'system', 'service'] as const;
export type EventActor = { type: (typeof ACTOR_TYPES)[number]; id: string };

export const EnvelopeBase = z.object({
  id: z.uuid(),
  type: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  orgId: z.uuid().nullable(),
  actor: z.object({ type: z.enum(ACTOR_TYPES), id: z.string().min(1) }),
  aggregate: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    version: z.int().nonnegative(),
  }),
  correlationId: z.string().min(1),
  causationId: z.string().nullable(),
  traceparent: z.string().optional(),
});
export type EventEnvelope<P> = z.infer<typeof EnvelopeBase> & { data: P };

const WithData = z.object({ data: z.unknown() });

/** Validate khung envelope và `data` theo schema của đúng `type@version`; sai thì ném `ZodError`. */
export function parseEnvelope<S extends z.ZodType>(
  def: EventDef<S>,
  raw: unknown,
): EventEnvelope<z.infer<S>> {
  const base = EnvelopeBase.parse(raw);
  if (base.type !== def.type || base.version !== def.version)
    throw new Error(
      `Envelope ${base.type}@${base.version} does not match definition ${def.type}@${def.version}`,
    );
  const data = def.schema.parse(WithData.parse(raw).data);
  return { ...base, data };
}
