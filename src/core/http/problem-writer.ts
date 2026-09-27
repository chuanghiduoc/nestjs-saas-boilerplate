import { HttpStatus } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import {
  PROBLEM_JSON,
  problemBody,
  type AppError,
  type ProblemMeta,
} from '../errors/index.js';

/**
 * Ghi problem+json cho middleware Node tự kết thúc response. `413`: `Connection: close` (client đang stream
 * body quá cỡ không được giữ socket). Header đã gửi thì huỷ socket (không đổi status được nữa).
 */
export function writeProblem(
  res: ServerResponse,
  err: AppError,
  meta: ProblemMeta,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [k, v] of Object.entries(err.opts.headers ?? {}))
    res.setHeader(k, v);
  if (err.error.status === HttpStatus.PAYLOAD_TOO_LARGE)
    res.setHeader('Connection', 'close');
  res.statusCode = err.error.status;
  res.setHeader('Content-Type', PROBLEM_JSON);
  res.end(JSON.stringify(problemBody(err, meta, true)));
}
