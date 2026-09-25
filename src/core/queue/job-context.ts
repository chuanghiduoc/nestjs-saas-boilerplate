import type { Logger } from '@nestjs/common';
import type { JobMeta } from './job-definition.js';

/**
 * `attempt` bắt đầu từ 1. Handler có thể chạy lại (retry, stalled job), nên tác dụng phụ
 * ngoài DB phải idempotent.
 *
 * `signal` bị abort khi worker tắt quá hạn chờ. Handler chạy lâu nên theo dõi nó và khi bị
 * abort thì ném lỗi (`signal.throwIfAborted()`), không bao giờ return thành công sau abort.
 * WorkerHost cũng tự ném lỗi retry được nếu handler return khi signal đã abort, để job không
 * bị ghi `completed` khi việc còn dở.
 */
export type JobContext<P> = {
  payload: P;
  meta: JobMeta;
  jobId: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  log: Logger;
};
