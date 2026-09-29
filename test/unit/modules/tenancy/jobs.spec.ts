import { describe, expect, it } from 'vitest';
import { assertEnqueueOpts } from '../../../../src/core/queue/job-definition.js';
// `cronRegistry` không có trong `core/scheduler/index.ts`; chỉ `cron-definition.ts` export nó (review M1).
import { cronRegistry } from '../../../../src/core/scheduler/cron-definition.js';
import {
  PurgeOrgJob,
  PurgeOrgsJob,
  purgeJobId,
} from '../../../../src/modules/tenancy/jobs.js';

describe('tenancy jobs (spec SP3 §9.5, CDX-7)', () => {
  it('the per-org purge job runs on inactive orgs and its jobId passes the core rules (no ":")', () => {
    expect(PurgeOrgJob.onInactiveOrg).toBe('run');
    const id = purgeJobId('0198c000-0000-7000-8000-000000000001');
    expect(id).toBe('tenancy-purge-0198c000-0000-7000-8000-000000000001');
    expect(() => assertEnqueueOpts(PurgeOrgJob, { jobId: id })).not.toThrow();
  });
  it('the cron is registered on the maintenance queue', () => {
    expect(
      cronRegistry().find((c) => c.key === 'tenancy.orgs.purge')?.job,
    ).toBe(PurgeOrgsJob);
    expect(PurgeOrgsJob.onInactiveOrg).toBe('skip');
  });
});
