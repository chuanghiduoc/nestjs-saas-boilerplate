import type { Logger } from '@nestjs/common';
import type { JobMeta } from './job-definition.js';

/**
 * `attempt` bắt đầu từ 1. `signal` bị abort khi worker tắt quá hạn chờ; handler chạy lâu
 * nên theo dõi nó. Handler có thể chạy lại (retry, stalled job), nên tác dụng phụ ngoài DB
 * phải idempotent.
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
