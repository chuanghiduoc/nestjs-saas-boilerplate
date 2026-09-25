import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra, type Creds } from '../../support/infra.js';

async function connect(
  creds: Creds,
  via: 'postgres' | 'pgbouncer' = 'postgres',
): Promise<pg.Client> {
  const infra = getInfra();
  const target = via === 'postgres' ? infra.pg : infra.pgbouncer;
  const c = new pg.Client({
    host: target.host,
    port: target.port,
    database: infra.pg.database,
    user: creds.user,
    password: creds.password,
  });
  await c.connect();
  return c;
}

describe('database roles', () => {
  let app: pg.Client;
  let relay: pg.Client;
  beforeAll(async () => {
    app = await connect(getInfra().pg.app);
    relay = await connect(getInfra().pg.relay);
  });
  afterAll(async () => {
    await app.end();
    await relay.end();
  });

  it('app_user and app_relay are neither superuser nor BYPASSRLS', async () => {
    for (const c of [app, relay]) {
      const { rows } = await c.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    }
  });

  it('app_user cannot create tables', async () => {
    await expect(
      app.query('CREATE TABLE t_forbidden (id int)'),
    ).rejects.toThrow(/permission denied/);
  });

  it('role-level statement_timeout applies when connecting through PgBouncer', async () => {
    const viaBouncer = await connect(getInfra().pg.app, 'pgbouncer');
    try {
      const { rows } = await viaBouncer.query<{ statement_timeout: string }>(
        'SHOW statement_timeout',
      );
      expect(rows[0]!.statement_timeout).not.toBe('0');
      await expect(viaBouncer.query('SELECT pg_sleep(30)')).rejects.toThrow(
        /statement timeout/,
      );
    } finally {
      await viaBouncer.end();
    }
  });
});
