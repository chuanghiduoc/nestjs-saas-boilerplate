import { z } from 'zod';
import { defineJob, defineQueue } from '../../core/queue/index.js';
import { defineOrgSweep } from '../../core/sweep/index.js';
import { WEBHOOKS_OUT } from './constants.js';
import { integrationsConfig } from './integrations.config.js';

/** Queue riêng cho lời gọi ra ngoài (spec cha §6): một endpoint chậm chỉ chiếm slot của queue này. */
export const WebhooksOutQueue = defineQueue(WEBHOOKS_OUT, { kind: 'io' });
/** Payload chỉ có id (không URL, không body). `run`: delivery sinh trước khi org bị xoá mềm vẫn được gửi (spec §8.3). */
export const DeliverWebhookJob = defineJob({
  name: 'integrations.deliver-webhook',
  queue: WebhooksOutQueue,
  version: 1,
  schema: z.object({ deliveryId: z.uuid() }).strict(),
  onInactiveOrg: 'run',
});
/**
 * Việc theo org của sweep (org trong `meta.orgId`). `run` cả khi org đã xoá mềm (review 6C I4, spec §10 sửa theo): delivery
 * của org đó vẫn được gửi (`DeliverWebhookJob` là `run`), nên lease hết hạn hay job bị mất của nó cũng phải được sweep lấy
 * lại; `skip` sẽ để delivery `SENDING` kẹt tới khi purge. Org đã purge thì không còn dòng nào để quét.
 */
export const IntegrationsSweepOrgJob = defineJob({
  name: 'integrations.sweep-org',
  queue: WebhooksOutQueue,
  version: 1,
  schema: z.object({}),
  onInactiveOrg: 'run',
});
/** Spec §8.3 "Sweep", R-X14: tham số thêm theo tên; cron ở `maintenance`, việc theo org ở `webhooks-out`. */
export const IntegrationsSweep = defineOrgSweep({
  key: 'integrations.sweep-orgs',
  definerFunction: 'integrations_orgs_due',
  extraParams: () => ({ p_grace_sec: integrationsConfig().sweepGraceSec }),
  orgJob: IntegrationsSweepOrgJob,
  jobIdPrefix: 'integrations-sweep',
  schedule: () => {
    const c = integrationsConfig();
    return { cron: c.sweepCron, tz: c.sweepTz };
  },
  batch: () => {
    const c = integrationsConfig();
    return { size: c.sweepBatchSize, maxBatches: c.sweepMaxBatches };
  },
});

/** jobId của lần thử thứ `attempt` (spec §10). Chỉ dùng cho attempt chưa từng được claim (xem `DeliveryEffect`). */
export const deliveryJobId = (publicId: string, attempt: number): string =>
  `webhook-${publicId}-a${attempt}`;
/**
 * Hẹn kiểm lại khi kill switch bật: job `a<attempt>` đang chạy còn trong Redis (active rồi completed), dùng lại id đó sẽ bị
 * BullMQ bỏ qua. Hậu tố mốc thời gian làm mỗi lần hẹn là một job mới.
 */
export const killedJobId = (
  publicId: string,
  attempt: number,
  atMs: number,
): string => `webhook-${publicId}-a${attempt}-k${atMs}`;
/** Claim bị từ chối vì endpoint đã đủ in-flight (R-X35): cùng lý do với `killedJobId` (job `a<attempt>` đang chạy còn trong Redis). */
export const busyJobId = (
  publicId: string,
  attempt: number,
  atMs: number,
): string => `webhook-${publicId}-a${attempt}-b${atMs}`;
/** Sweep enqueue lại delivery quá hạn: tối đa một job mỗi slot của sweep, không bị job đã hoàn tất cùng id nuốt mất. */
export const sweptJobId = (
  publicId: string,
  attempt: number,
  slot: number,
): string => `webhook-${publicId}-a${attempt}-s${slot}`;
