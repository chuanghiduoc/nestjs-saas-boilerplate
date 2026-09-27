import { HttpStatus } from '@nestjs/common';
import { AppError } from './app-error.js';

export const PROBLEM_JSON = 'application/problem+json';
export type ProblemMeta = {
  instance: string;
  requestId: string;
  typeBase: string;
};

/**
 * Luật lộ `detail` duy nhất (SP1, ruling S2-R8), dùng chung cho `ProblemDetailsFilter`, `writeProblem` và bản lưu
 * idempotency: 4xx luôn lộ; 5xx chỉ lộ khi chính code ném `AppError` (detail do mình viết). Lỗi lạ hoặc lỗi được
 * mapper chuyển thành 5xx (DB, Redis…) có thể mang chi tiết hạ tầng nên bị ẩn.
 * `exception` là lỗi gốc TRƯỚC `toAppError`, `appError` là kết quả chuẩn hoá của nó.
 */
export const exposesDetail = (
  exception: unknown,
  appError: AppError,
): boolean =>
  appError.error.status < HttpStatus.INTERNAL_SERVER_ERROR ||
  exception instanceof AppError;

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
