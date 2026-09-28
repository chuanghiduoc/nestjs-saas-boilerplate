import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';
import { seedOrg, type SeededOrg } from '../../../support/tenancy-seed.js';

describe('scheduled_tasks.job_name format CHECK (SP1 follow-up, spec §10)', () => {
  let app: pg.Client;
  let org: SeededOrg;
  beforeAll(async () => {
    org = await seedOrg();
    const { pg: p } = getInfra();
    app = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.app,
    });
    await app.connect();
  });
  afterAll(async () => {
    await app?.end();
    await org?.dispose();
  });

  const insert = async (jobName: string) => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await app.query(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'k', $2, '0 * * * *', 'UTC', '{}', true)`,
        [org.orgId, jobName],
      );
    } finally {
      await app.query('ROLLBACK');
    }
  };
  it('accepts a registered-style job name', async () => {
    await expect(insert('billing.invoice.remind')).resolves.toBeUndefined();
  });
  it.each(['Billing.Remind', 'job with space', 'x;drop', ''])(
    'rejects %j (23514)',
    async (name) => {
      await expect(insert(name)).rejects.toMatchObject({ code: '23514' });
    },
  );
});
