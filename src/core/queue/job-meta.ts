import type { RequestContext } from '../context/index.js';
import { currentTraceparent } from '../observability/trace-propagation.js';
import {
  JobPayloadError,
  type JobDef,
  type JobMeta,
} from './job-definition.js';

/**
 * Meta hiệu lực của job phát ra từ context hiện tại, dùng chung cho `JobQueue` và `SafeEnqueue`.
 *
 * Org (spec SP1 §5.4, cùng luật với `OutboxWriter.append`; `EventPublisher` thì luôn lấy org của
 * context): trong một org thì job LUÔN thuộc org của context — `extra.orgId` khác org đó là lỗi của
 * caller (`JobPayloadError`, không bị SafeEnqueue hoãn qua outbox), vì WorkerHost sẽ mở OrgScope
 * theo `meta.orgId` và job chạy dưới RLS của tenant khác. `extra.orgId: undefined` không xoá
 * được org của context. Ngoài org (job hệ thống: relay, reconcile, test) thì `extra.orgId` chọn org.
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
  const contextOrg = ctx.orgId();
  if (
    contextOrg !== undefined &&
    extra.orgId !== undefined &&
    extra.orgId.toLowerCase() !== contextOrg
  )
    throw new JobPayloadError(
      job.name,
      `meta.orgId ${extra.orgId} does not match the context org ${contextOrg}; a job enqueued inside an org always belongs to that org`,
    );
  const meta: JobMeta = {
    requestId: ctx.requestId(),
    ...extra,
    orgId: contextOrg ?? extra.orgId,
  };
  meta.traceparent ??= currentTraceparent() ?? ctx.traceparent();
  return meta;
}
