import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';
import { createScratchDb } from '../../support/scratch-db.js';

const PREFIX = 'scratch_leak_probe';

describe('createScratchDb', () => {
  it('drops the database it created when the init script fails afterwards', async () => {
    await expect(
      createScratchDb(PREFIX, '/nonexistent-init-script.sh'),
    ).rejects.toThrow(/docker exec failed/);

    const { pg } = getInfra();
    const client = new Client({
      host: pg.host,
      port: pg.port,
      database: pg.database,
      ...pg.owner,
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname LIKE $1',
        [`${PREFIX}\\_%`],
      );
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
