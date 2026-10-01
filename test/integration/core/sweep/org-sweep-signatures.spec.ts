import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Nạp đủ module của app: mọi `defineOrgSweep` chạy lúc import (6A/6C/SP5/SP7 thêm sweep của mình ở đây). `app.modules.ts` là
// danh sách module chung của api và worker; không import `app-api.module`/`app-worker.module` cùng lúc: mỗi file gọi
// `DatabaseModule.forRoot()` lúc import và `@mikro-orm/nestjs` ném `ContextName 'app' already registered` ở lần thứ hai.
import '../../../../src/app.modules.js';
import { orgSweepRegistry } from '../../../../src/core/sweep/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { sweepSignatureProblems } from '../../../support/org-sweep-signatures.js';

const FIXTURE = {
  definerFunction: 'fixture_orgs_due',
  extraParams: () => ({ p_tag: 't', p_min_age_sec: 1 }),
};

describe('org sweep signatures in pg_proc (R-X14, spec SP6 C-8b)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => owner?.end());

  it('every sweep the app registers matches its SQL function', async () => {
    for (const def of orgSweepRegistry())
      expect(await sweepSignatureProblems(owner, def), def.key).toEqual([]);
  });
  it('the fixture sweep matches, whatever the order of its extra parameters', async () => {
    expect(await sweepSignatureProblems(owner, FIXTURE)).toEqual([]);
    expect(
      await sweepSignatureProblems(owner, {
        ...FIXTURE,
        extraParams: () => ({ p_min_age_sec: 1, p_tag: 't' }),
      }),
    ).toEqual([]);
  });
  it('a renamed parameter, a wrong type or a missing parameter makes the check fail', async () => {
    expect(
      await sweepSignatureProblems(owner, {
        ...FIXTURE,
        extraParams: () => ({ p_tag: 't', p_min_age: 1 }),
      }),
    ).toEqual([
      'p_min_age is not a parameter of fixture_orgs_due',
      'fixture_orgs_due: parameter p_min_age_sec is never passed by the sweep',
    ]);
    expect(
      await sweepSignatureProblems(owner, {
        ...FIXTURE,
        extraParams: () => ({ p_tag: 5, p_min_age_sec: 1 }),
      }),
    ).toEqual(['fixture_orgs_due: p_tag is text but the sweep passes integer']);
  });
  it('a second overload makes the check fail (rolled back)', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE sweep_definer');
      await owner.query(
        `CREATE FUNCTION public.fixture_orgs_due(p_after uuid, p_limit integer) RETURNS TABLE (org_id uuid)
         LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS 'SELECT NULL::uuid WHERE false'`,
      );
      await owner.query('RESET ROLE');
      expect(await sweepSignatureProblems(owner, FIXTURE)).toEqual([
        'fixture_orgs_due has 2 overloads in public (exactly one is required)',
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
