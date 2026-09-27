import type { AppError } from './app-error.js';

export const PROBLEM_JSON = 'application/problem+json';
export type ProblemMeta = {
  instance: string;
  requestId: string;
  typeBase: string;
};

/**
 * Thân problem+json (RFC 9457) dùng chung cho `ProblemDetailsFilter` (route Nest) và `writeProblem`
 * (middleware Node tự trả response, vd. `/api/auth/*`), để hai đường không lệch hình dạng.
 */
export function problemBody(
  err: AppError,
  meta: ProblemMeta,
  exposeDetail: boolean,
): Record<string, unknown> {
  const { error, opts } = err;
  return {
    type: `${meta.typeBase}/${error.code.replaceAll('_', '-')}`,
    title: error.title,
    status: error.status,
    code: error.code,
    ...(exposeDetail && opts.detail ? { detail: opts.detail } : {}),
    instance: meta.instance,
    requestId: meta.requestId,
    timestamp: new Date().toISOString(),
    ...(opts.fields?.length ? { errors: opts.fields } : {}),
  };
}
