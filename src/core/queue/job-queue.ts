import type { z } from 'zod';
import type { JobDef, JobMeta } from './job-definition.js';

/** `jobId` cố định để chống trùng: job cùng id còn được giữ trong Redis thì lần thêm sau bị bỏ qua. */
export type EnqueueOpts = { jobId?: string; delayMs?: number; meta?: JobMeta };
export type EnqueueItem = { job: JobDef; payload: unknown; opts?: EnqueueOpts };

export abstract class JobQueue {
  abstract enqueue<S extends z.ZodType>(
    job: JobDef<S>,
    payload: z.infer<S>,
    opts?: EnqueueOpts,
  ): Promise<string>;
  /** Payload chưa có type (ví dụ đọc từ outbox) — vẫn được validate bằng schema của job. */
  abstract enqueueDynamic(
    job: JobDef,
    payload: unknown,
    opts?: EnqueueOpts,
  ): Promise<string>;
  /**
   * Validate mọi item trước khi ghi; id trả về theo thứ tự `items`. Chỉ atomic trong từng
   * queue, KHÔNG atomic giữa các queue: lỗi ở queue sau không huỷ job đã thêm vào queue trước.
   * Muốn retry an toàn thì mỗi item cần `jobId` cố định để chống trùng.
   */
  abstract enqueueMany(items: EnqueueItem[]): Promise<string[]>;
}
