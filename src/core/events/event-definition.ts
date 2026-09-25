import type { z } from 'zod';

export type EventDef<S extends z.ZodType = z.ZodType> = {
  readonly type: string;
  readonly version: number;
  readonly schema: S;
};

/** `context.aggregate.verb`, ví dụ `billing.invoice.paid`. */
const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const events = new Map<string, EventDef>();

/** Khoá registry và định danh subscriber theo event: `type@version`. */
export const eventKey = (type: string, version: number): string =>
  `${type}@${version}`;

/**
 * Mỗi `type@version` định nghĩa đúng một lần. Đổi hình dạng payload theo cách không tương thích
 * thì tạo version mới, giữ version cũ tới khi không còn dòng outbox/subscriber nào dùng.
 */
export function defineEvent<S extends z.ZodType>(def: {
  type: string;
  version: number;
  schema: S;
}): EventDef<S> {
  if (!TYPE_PATTERN.test(def.type))
    throw new Error(
      `Event type "${def.type}" must follow context.aggregate.verb`,
    );
  if (!Number.isInteger(def.version) || def.version <= 0)
    throw new Error(
      `Event "${def.type}" version must be a positive integer, got ${def.version}`,
    );
  const key = eventKey(def.type, def.version);
  if (events.has(key)) throw new Error(`Event "${key}" already defined`);
  const full: EventDef<S> = {
    type: def.type,
    version: def.version,
    schema: def.schema,
  };
  events.set(key, full);
  return full;
}

export const findEvent = (
  type: string,
  version: number,
): EventDef | undefined => events.get(eventKey(type, version));
export const eventRegistry = (): EventDef[] => [...events.values()];
