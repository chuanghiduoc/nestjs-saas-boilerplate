import { Global, Module } from '@nestjs/common';
import { OrgActivityGate } from '../../../../core/queue/index.js';
import { TenancyOrgActivityGate } from '../../application/org-activity.gate.js';

/** `@Global`: `WorkerHost` (core) inject `@Optional() OrgActivityGate` (spec SP3 §5.2). Chỉ nạp ở `forWorker()`. */
@Global()
@Module({
  providers: [
    TenancyOrgActivityGate,
    { provide: OrgActivityGate, useExisting: TenancyOrgActivityGate },
  ],
  exports: [OrgActivityGate],
})
export class TenancyQueuePortsModule {}
