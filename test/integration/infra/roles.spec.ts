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

describe('auth_user isolation', () => {
  it('cannot read or call anything in public (42501), directly and through PgBouncer', async () => {
    for (const via of ['postgres', 'pgbouncer'] as const) {
      const c = await connect(getInfra().pg.auth, via);
      try {
        await expect(
          c.query('SELECT 1 FROM public.outbox_events LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          c.query('SELECT public.app_current_org()'),
        ).rejects.toMatchObject({ code: '42501' });
        const { rows } = await c.query<{ search_path: string }>(
          'SHOW search_path',
        );
        expect(rows[0]!.search_path).toBe('auth');
        const timeout = await c.query<{ statement_timeout: string }>(
          'SHOW statement_timeout',
        );
        expect(timeout.rows[0]!.statement_timeout).not.toBe('0');
      } finally {
        await c.end();
      }
    }
  });

  it('cannot create objects in schema auth (42501)', async () => {
    const c = await connect(getInfra().pg.auth);
    try {
      await expect(
        c.query('CREATE TABLE auth.t_forbidden (id int)'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });

  it('app_user cannot use schema auth (42501)', async () => {
    const c = await connect(getInfra().pg.app);
    try {
      await expect(
        c.query('SELECT 1 FROM auth.anything'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});
