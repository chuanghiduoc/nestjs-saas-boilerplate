import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { identityGuardConfig } from './identity.config.js';

export const ReconcileRegisteredJob = defineJob({
  name: 'identity.reconcile-registered',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
/** S2-R75: gửi bù thông báo bảo mật còn marker chưa gửi (`auth.security_notice`). */
export const ReconcileSecurityNoticesJob = defineJob({
  name: 'identity.reconcile-security-notices',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
export const PurgeExpiredJob = defineJob({
  name: 'identity.purge-expired',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});

defineCron({
  key: 'identity.reconcile-registered',
  job: ReconcileRegisteredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.registeredReconcileCron, tz: c.registeredReconcileTz };
  },
});
defineCron({
  key: 'identity.reconcile-security-notices',
  job: ReconcileSecurityNoticesJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return {
      cron: c.securityNoticeReconcileCron,
      tz: c.securityNoticeReconcileTz,
    };
  },
});
defineCron({
  key: 'identity.purge-expired',
  job: PurgeExpiredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});
