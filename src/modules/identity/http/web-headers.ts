import type { IncomingMessage } from 'node:http';

/** Header Node → `Headers` của Web (Better Auth/jose nhận `Headers`). */
export function toWebHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined)
      for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  return h;
}
