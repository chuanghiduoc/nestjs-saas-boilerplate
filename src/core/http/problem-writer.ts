import { HttpStatus } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import {
  PROBLEM_JSON,
  exposesDetail,
  problemBody,
  toAppError,
  type ProblemMeta,
} from '../errors/index.js';

/**
 * Ghi problem+json cho middleware Node tự kết thúc response. `413`: `Connection: close` (client đang stream
 * body quá cỡ không được giữ socket). Header đã gửi thì huỷ socket (không đổi status được nữa).
 * Nhận lỗi GỐC (chưa `toAppError`) để áp đúng luật lộ `detail` của `ProblemDetailsFilter` (`exposesDetail`):
 * cùng một lỗi cho ra cùng một thân ở hai đường.
 * Hàm không log: caller chịu trách nhiệm log lỗi (5xx → error, lỗi dự kiến → warn) như `ProblemDetailsFilter`.
 */
export function writeProblem(
  res: ServerResponse,
  exception: unknown,
  meta: ProblemMeta,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const err = toAppError(exception);
  for (const [k, v] of Object.entries(err.opts.headers ?? {}))
    res.setHeader(k, v);
  if (err.error.status === HttpStatus.PAYLOAD_TOO_LARGE)
    res.setHeader('Connection', 'close');
  res.statusCode = err.error.status;
  res.setHeader('Content-Type', PROBLEM_JSON);
  res.end(
    JSON.stringify(problemBody(err, meta, exposesDetail(exception, err))),
  );
}
