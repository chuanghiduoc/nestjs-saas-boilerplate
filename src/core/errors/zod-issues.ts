import type { FieldError } from './app-error.js';

export type ZodIssueLike = {
  code?: string;
  path?: readonly (PropertyKey | { key: PropertyKey })[];
  message: string;
  format?: string;
};

export function zodIssuesToFields(
  issues: readonly ZodIssueLike[],
): FieldError[] {
  return issues.map((i) => ({
    path: (i.path ?? [])
      .map((s) => String(typeof s === 'object' ? s.key : s))
      .join('.'),
    code:
      i.code === 'invalid_format' && i.format
        ? `invalid_${i.format}`
        : (i.code ?? 'invalid'),
    message: i.message,
  }));
}
