import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedOrg,
  seedOrgApiKey,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** R-X23: quyền chỉ có trong DB (module của nó không nạp ở app này), eligible cho key. */
const ORPHAN = 'ghost.read';
const PROCESS_ENV: Record<string, string> = {
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};

/** App ở process con để đọc đúng output JSON của pino (cùng cách `roles-pii-logs.e2e.spec.ts`). */
describe('orphan keys inside a delegation scope (R-X21, R-X23)', () => {
  let api: AppProcess | undefined;
  let O: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    await ownerQuery(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('ghost', 'read', false, true, true) ON CONFLICT ON CONSTRAINT permissions_key_uq DO NOTHING`,
    );
    api = await startAppProcess('test/support/api-entry.ts', {
      ...baseTestEnv(),
      ...PROCESS_ENV,
    });
    O = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: O.authUserId } });
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    await ownerQuery(`DELETE FROM permissions WHERE key = $1`, [ORPHAN]);
    await deleteSeededPrincipals([O]);
  });

  it('a key whose stored scope holds an unloaded permission still works for the rest; the orphan grants nothing; WARN once per key', async () => {
    const key = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: ['org.read', ORPHAN],
    });
    for (let i = 0; i < 2; i++) {
      const r = await fetch(
        `http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}`,
        { headers: { 'x-api-key': key.token } },
      );
      expect(r.status).toBe(200);
    }
    const lines = (api?.output() ?? '')
      .split('\n')
      .filter((l) => l.includes('orphan_permission_ignored'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ORPHAN);
    expect(api?.output()).not.toContain(key.token);
  });
});
