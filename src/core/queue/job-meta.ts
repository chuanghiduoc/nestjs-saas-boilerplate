import type { RequestContext } from '../context/index.js';
import { currentTraceparent } from '../observability/trace-propagation.js';
import {
  JobPayloadError,
  type JobDef,
  type JobMeta,
} from './job-definition.js';

/**
 * Org của job phát ra từ context hiện tại (spec SP1 §5.4, cùng luật với `OutboxWriter.append`;
 * `EventPublisher` thì luôn lấy org của context), dùng cho `JobQueue`, `SafeEnqueue` và
 * `JobScheduler.upsert`: trong một org thì job LUÔN thuộc org của context — `explicit` khác org đó
 * là lỗi của caller (`JobPayloadError`, không bị SafeEnqueue hoãn qua outbox), vì WorkerHost sẽ mở
 * OrgScope theo `meta.orgId` và job chạy dưới RLS của tenant khác. `explicit: undefined` không xoá
 * được org của context. Ngoài org (code hệ thống: relay, reconciler, StaticScheduler, test) thì
 * `explicit` chọn org.
 */
export function resolveJobOrgId(
  job: JobDef,
  ctx: RequestContext,
  explicit: string | undefined,
): string | undefined {
  const contextOrg = ctx.orgId();
  if (contextOrg === undefined) return explicit;
  if (explicit !== undefined && explicit.toLowerCase() !== contextOrg)
    throw new JobPayloadError(
      job.name,
      `meta.orgId ${explicit} does not match the context org ${contextOrg}; a job enqueued inside an org always belongs to that org`,
    );
  return contextOrg;
}

/**
 * Meta hiệu lực của job phát ra từ context hiện tại, dùng chung cho `JobQueue` và `SafeEnqueue`.
 * Org theo `resolveJobOrgId`.
 *
 * `traceparent` do caller truyền (relay/dispatch: trace của request gốc qua outbox) được giữ
 * nguyên; không có thì lấy span đang active, rồi tới traceparent của context (job nhận từ
 * producer khi process này tắt OTel).
 */
export function resolveJobMeta(
  job: JobDef,
  ctx: RequestContext,
  extra: JobMeta = {},
): JobMeta {
  const meta: JobMeta = {
    requestId: ctx.requestId(),
    ...extra,
    orgId: resolveJobOrgId(job, ctx, extra.orgId),
  };
  meta.traceparent ??= currentTraceparent() ?? ctx.traceparent();
  return meta;
}
