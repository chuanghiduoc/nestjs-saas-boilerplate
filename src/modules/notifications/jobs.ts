import { z } from 'zod';
import {
  MaintenanceQueue,
  defineJob,
  defineQueue,
} from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { notificationsConfig } from './notifications.config.js';

export const NotificationsQueue = defineQueue('notifications', { kind: 'io' });
/** Payload chỉ có id: không PII trong Redis, failed reason hay Bull Board (spec §5.12). */
export const SendEmailJob = defineJob({
  name: 'notifications.send-email',
  queue: NotificationsQueue,
  version: 1,
  schema: z.object({ deliveryId: z.uuid() }).strict(),
});
export const ReconcileDeliveriesJob = defineJob({
  name: 'notifications.reconcile-deliveries',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
export const PurgeDeliveriesJob = defineJob({
  name: 'notifications.purge-deliveries',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});

defineCron({
  key: 'notifications.reconcile-deliveries',
  job: ReconcileDeliveriesJob,
  payload: {},
  schedule: () => {
    const c = notificationsConfig();
    return { cron: c.reconcileCron, tz: c.reconcileTz };
  },
});
defineCron({
  key: 'notifications.purge-deliveries',
  job: PurgeDeliveriesJob,
  payload: {},
  schedule: () => {
    const c = notificationsConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});

/** jobId của lần enqueue thứ `generation` (0 = lúc tạo; tăng mỗi lần cron đối soát enqueue lại). */
export const sendEmailJobId = (publicId: string, generation: number): string =>
  `${publicId}-g${generation}`;
