import { describe, expect, it } from 'vitest';
import * as tenancy from '../../../../src/modules/tenancy/index.js';

describe('tenancy public API (spec SP3 §18.6 rule 19)', () => {
  it('never exports the race-test seam: outside modules/tenancy it is reachable only through a deep import, which depcruise rejects', () => {
    const exported = Object.keys(tenancy);
    expect(exported).not.toContain('TenancyTestHooks');
    expect(exported).not.toContain('NoopTenancyTestHooks');
  });
});
