import type { ErrorCode } from './error-codes.js';

export type FieldError = { path: string; code: string; message: string };

export class AppError extends Error {
  constructor(
    readonly error: ErrorCode,
    readonly opts: {
      detail?: string;
      fields?: FieldError[];
      headers?: Record<string, string>;
      /**
       * Lỗi là trạng thái dự kiến (vd. readiness 503 khi đang draining): filter log một dòng `warn`
       * không có stack thay vì `error`. `cause` khi đó phải là dữ liệu thuần (được log nguyên).
       */
      expected?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(opts.detail ?? error.title, { cause: opts.cause });
    this.name = 'AppError';
  }
}
