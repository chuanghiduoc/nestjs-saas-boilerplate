import type { z } from 'zod';

export type HeaderWriter = { setHeader(k: string, v: string): void };

/** Chỉ trả field khai báo trong schema (z.object bỏ key lạ). Sai schema là bug phía server → 500. */
export function serialize<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.infer<S> {
  return schema.parse(value);
}

export function setLocation(res: HeaderWriter, location: string): void {
  res.setHeader('Location', location);
}
