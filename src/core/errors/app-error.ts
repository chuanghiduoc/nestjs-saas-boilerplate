import type { ErrorCode } from './error-codes.js';

export type FieldError = { path: string; code: string; message: string };

export class AppError extends Error {
  constructor(
    readonly error: ErrorCode,
    readonly opts: {
      detail?: string;
      fields?: FieldError[];
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(opts.detail ?? error.title, { cause: opts.cause });
    this.name = 'AppError';
  }
}
