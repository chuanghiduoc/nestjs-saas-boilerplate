import type { ServerResponse } from 'node:http';
import {
  PROBLEM_JSON,
  exposesDetail,
  problemBody,
  toAppError,
  type ProblemMeta,
} from '../errors/index.js';

/** Đúng header mà `ProblemDetailsFilter` trả qua Express (`res.json` luôn thêm `charset=utf-8`). */
const PROBLEM_JSON_UTF8 = `${PROBLEM_JSON}; charset=utf-8`;

/**
 * Ghi problem+json cho middleware Node tự kết thúc response, cùng header và thân với `ProblemDetailsFilter`.
 * Header đã gửi thì huỷ socket (không đổi status được nữa). `413` KHÔNG kèm `Connection: close` (ruling S2-R12):
 * với header đó Node huỷ socket khi client còn đang gửi body và client nhận RST thay vì 413. Middleware nào ngừng
 * đọc một body quá cỡ phải tự lingering close như `jsonBodyParser`.
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
  res.statusCode = err.error.status;
  res.setHeader('Content-Type', PROBLEM_JSON_UTF8);
  res.end(
    JSON.stringify(problemBody(err, meta, exposesDetail(exception, err))),
  );
}
