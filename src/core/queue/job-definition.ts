import { z } from 'zod';

export type QueueKind = 'io' | 'cpu';
export type QueueDef = { readonly name: string; readonly kind: QueueKind };

/** Ngữ cảnh đi kèm job; `orgId` được validate ở cả hai đầu để job sai org thất bại ngay, không retry. */
const JobMetaSchema = z.object({
  requestId: z.string().optional(),
  traceparent: z.string().optional(),
  orgId: z.uuid().optional(),
});
export type JobMeta = z.infer<typeof JobMetaSchema>;

/** Dạng lưu trong Redis: `v` = version của schema payload, `p` = payload, `meta` = ngữ cảnh. */
const JobDataSchema = z.object({
  v: z.number().int(),
  p: z.unknown(),
  meta: JobMetaSchema.default({}),
});
export type JobData = { v: number; p: unknown; meta: JobMeta };

export type JobDef<S extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly queue: QueueDef;
  readonly version: number;
  readonly schema: S;
  readonly tenantSchedulable: boolean;
};

export class JobPayloadError extends Error {
  constructor(job: string, detail: string) {
    super(`Invalid payload for job "${job}": ${detail}`);
    this.name = 'JobPayloadError';
  }
}

/** BullMQ không cho ":" trong tên queue/jobId. */
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/;
const queues = new Map<string, QueueDef>();
const jobs = new Map<string, JobDef>();

export function defineQueue(name: string, opts: { kind: QueueKind }): QueueDef {
  if (!NAME_PATTERN.test(name))
    throw new Error(`Queue name "${name}" must match ${NAME_PATTERN}`);
  if (queues.has(name)) throw new Error(`Queue "${name}" already defined`);
  const def: QueueDef = { name, kind: opts.kind };
  queues.set(name, def);
  return def;
}

export function defineJob<S extends z.ZodType>(def: {
  name: string;
  queue: QueueDef;
  version: number;
  schema: S;
  tenantSchedulable?: boolean;
}): JobDef<S> {
  if (!NAME_PATTERN.test(def.name))
    throw new Error(`Job name "${def.name}" must match ${NAME_PATTERN}`);
  if (jobs.has(def.name)) throw new Error(`Job "${def.name}" already defined`);
  const full: JobDef<S> = {
    ...def,
    tenantSchedulable: def.tenantSchedulable ?? false,
  };
  jobs.set(def.name, full);
  return full;
}

export const queueRegistry = (): QueueDef[] => [...queues.values()];
export const jobRegistry = (): JobDef[] => [...jobs.values()];
export const findJob = (name: string): JobDef | undefined => jobs.get(name);

/**
 * Kiểm tra option enqueue trước khi gửi, để lỗi của caller là `JobPayloadError` (không retry,
 * không bị SafeEnqueue coi là lỗi Redis). Luật jobId theo BullMQ `Job.validateOptions`:
 * không chứa `:` và không phải chuỗi số nguyên; chặt hơn BullMQ ở chỗ cấm mọi `:`.
 */
export function assertEnqueueOpts(
  job: JobDef,
  opts: { jobId?: string; delayMs?: number },
): void {
  const { jobId, delayMs } = opts;
  if (jobId !== undefined) {
    if (jobId === '' || jobId.includes(':'))
      throw new JobPayloadError(
        job.name,
        `jobId "${jobId}" must be non-empty and must not contain ":"`,
      );
    if (`${parseInt(jobId, 10)}` === jobId)
      throw new JobPayloadError(
        job.name,
        `jobId "${jobId}" must not be an integer`,
      );
  }
  if (delayMs !== undefined && (!Number.isInteger(delayMs) || delayMs < 0))
    throw new JobPayloadError(
      job.name,
      `delayMs must be a non-negative integer, got ${delayMs}`,
    );
}

export function encodeJobData(
  job: JobDef,
  payload: unknown,
  meta: JobMeta,
): JobData {
  const parsed = job.schema.safeParse(payload);
  if (!parsed.success)
    throw new JobPayloadError(job.name, parsed.error.message);
  const parsedMeta = JobMetaSchema.safeParse(meta);
  if (!parsedMeta.success)
    throw new JobPayloadError(job.name, `meta: ${parsedMeta.error.message}`);
  return { v: job.version, p: parsed.data, meta: parsedMeta.data };
}

export function decodeJobData<S extends z.ZodType>(
  job: JobDef<S>,
  data: unknown,
): { payload: z.infer<S>; meta: JobMeta } {
  const envelope = JobDataSchema.safeParse(data);
  if (!envelope.success)
    throw new JobPayloadError(job.name, envelope.error.message);
  const { v, p, meta } = envelope.data;
  if (v !== job.version)
    throw new JobPayloadError(
      job.name,
      `unsupported version ${v} (expected ${job.version})`,
    );
  const parsed = job.schema.safeParse(p);
  if (!parsed.success)
    throw new JobPayloadError(job.name, parsed.error.message);
  return { payload: parsed.data, meta };
}
