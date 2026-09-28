import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATE_KEYS } from '../../../src/modules/notifications/templates.js';
import { getInfra } from '../../support/infra.js';

let app: pg.Client;
const insert = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    public_id: v7(),
    template: 'verify-email',
    locale: 'en',
    recipient_enc: 'x',
    params_enc: 'y',
    state: 'PENDING',
    idempotency_key: `verify-email:${v7()}`,
    ...over,
  };
  const cols = Object.keys(row);
  return app.query<{ public_id: string }>(
    `INSERT INTO email_deliveries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING public_id`,
    Object.values(row),
  );
};
const insertedId = async (over: Record<string, unknown> = {}) => {
  const { rows } = await insert(over);
  const id = rows[0]?.public_id;
  if (!id) throw new Error('INSERT … RETURNING returned no row');
  return id;
};

/** Một dòng thoả mọi CHECK trừ đúng một ràng buộc được nêu tên. */
const sending = () => ({
  state: 'SENDING',
  attempts: 1,
  lease_owner: v7(),
  lease_until: new Date(),
});
const terminal = (state: 'SENT' | 'FAILED') => ({
  state,
  attempts: 1,
  params_enc: null,
  completed_at: new Date(),
});

// UPDATE đúng như thiết kế (spec §5.11), chạy bằng app_user.
const LEASE = '20 seconds';
const claim = (id: string, owner: string, lease = LEASE) =>
  app.query(
    `UPDATE email_deliveries
        SET state = 'SENDING', lease_owner = $2, lease_until = now() + $3::interval,
            attempts = attempts + 1, updated_at = now()
      WHERE public_id = $1
        AND (state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))`,
    [id, owner, lease],
  );
const release = (id: string, owner: string) =>
  app.query(
    `UPDATE email_deliveries
        SET state = 'PENDING', lease_owner = NULL, lease_until = NULL,
            last_error_code = 'SMTP_TRANSIENT', updated_at = now()
      WHERE public_id = $1 AND state = 'SENDING' AND lease_owner = $2`,
    [id, owner],
  );
const complete = (id: string, owner: string) =>
  app.query(
    `UPDATE email_deliveries
        SET state = 'SENT', completed_at = now(), params_enc = NULL,
            lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE public_id = $1 AND state = 'SENDING' AND lease_owner = $2`,
    [id, owner],
  );
const jobFail = (id: string, owner: string) =>
  app.query(
    `UPDATE email_deliveries
        SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(),
            params_enc = NULL, last_error_code = 'SMTP_PERMANENT', updated_at = now()
      WHERE public_id = $1 AND state = 'SENDING' AND lease_owner = $2`,
    [id, owner],
  );
const RECONCILE_WHERE = `public_id = $1 AND last_enqueued_at < now() - $2::interval
  AND (state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))`;
const reconcileFail = (id: string, maxAttempts: number) =>
  app.query(
    `UPDATE email_deliveries
        SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(),
            params_enc = NULL, updated_at = now()
      WHERE ${RECONCILE_WHERE} AND attempts >= $3`,
    [id, '0 seconds', maxAttempts],
  );
const reenqueue = (id: string) =>
  app.query<{ enqueue_generation: number }>(
    `UPDATE email_deliveries
        SET enqueue_generation = enqueue_generation + 1, last_enqueued_at = now(), updated_at = now()
      WHERE ${RECONCILE_WHERE} RETURNING enqueue_generation`,
    [id, '0 seconds'],
  );
const stateOf = async (id: string) =>
  (
    await app.query<{ state: string; attempts: number }>(
      'SELECT state, attempts FROM email_deliveries WHERE public_id = $1',
      [id],
    )
  ).rows[0];
const LONG_AGO = new Date(Date.UTC(2000, 0, 1));

beforeAll(async () => {
  const { pg: p } = getInfra();
  app = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.app,
  });
  await app.connect();
});
afterAll(async () => app?.end());

describe('email_deliveries constraints (spec §5.11, §5.16c) as app_user', () => {
  it.each(TEMPLATE_KEYS)(
    'accepts the registered template %s',
    async (template) => {
      await expect(
        insert({ template, idempotency_key: `${template}:${v7()}` }),
      ).resolves.toBeDefined();
    },
  );
  it('matches the template CHECK catalog to TEMPLATE_KEYS exactly', async () => {
    const { rows } = await app.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'public.email_deliveries'::regclass
         AND conname = 'email_deliveries_template_check'`,
    );
    expect(rows).toHaveLength(1);
    const keys = [
      ...(rows[0]?.definition ?? '').matchAll(/'([^']+)'::text/g),
    ].map((match) => match[1]);
    expect(keys).toEqual([...TEMPLATE_KEYS]);
  });
  it('accepts a valid PENDING row', async () => {
    await expect(insert()).resolves.toBeDefined();
  });
  it.each<[string, Record<string, unknown>, string]>([
    [
      'PENDING with lease_until',
      { lease_until: new Date() },
      'email_deliveries_lease_ck',
    ],
    [
      'PENDING with only lease_owner',
      { lease_owner: v7() },
      'email_deliveries_lease_ck',
    ],
    [
      'SENDING without owner',
      { ...sending(), lease_owner: null },
      'email_deliveries_lease_ck',
    ],
    [
      'SENDING with owner but no lease_until',
      { ...sending(), lease_until: null },
      'email_deliveries_lease_ck',
    ],
    [
      'SENT without completed_at',
      { ...terminal('SENT'), completed_at: null },
      'email_deliveries_completed_ck',
    ],
    [
      'PENDING with completed_at',
      { completed_at: new Date() },
      'email_deliveries_completed_ck',
    ],
    [
      'FAILED still holding params',
      { ...terminal('FAILED'), params_enc: 'y' },
      'email_deliveries_params_ck',
    ],
    [
      'PENDING without params',
      { params_enc: null },
      'email_deliveries_params_ck',
    ],
    [
      'SENDING without params',
      { ...sending(), params_enc: null },
      'email_deliveries_params_ck',
    ],
    [
      'SENDING that was never claimed (attempts 0)',
      { ...sending(), attempts: 0 },
      'email_deliveries_attempts_state_ck',
    ],
    [
      'FAILED that was never claimed (attempts 0)',
      { ...terminal('FAILED'), attempts: 0 },
      'email_deliveries_attempts_state_ck',
    ],
    [
      'unknown last_error_code',
      { last_error_code: 'SMTP_EXPLODED' },
      'email_deliveries_last_error_code_check',
    ],
    ['malformed locale', { locale: 'EN_us' }, 'email_deliveries_locale_check'],
    [
      'idempotency key of another template',
      { idempotency_key: `reset-password:${v7()}` },
      'email_deliveries_idempotency_prefix_ck',
    ],
    [
      'unknown template',
      { template: 'newsletter', idempotency_key: `newsletter:${v7()}` },
      'email_deliveries_template_check',
    ],
    ['negative attempts', { attempts: -1 }, 'email_deliveries_attempts_check'],
  ])('rejects %s (23514)', async (_name, over, constraint) => {
    await expect(insert(over)).rejects.toMatchObject({
      code: '23514',
      constraint,
    });
  });
  it('rejects a duplicate idempotency key (23505)', async () => {
    const key = `verify-email:${v7()}`;
    await insert({ idempotency_key: key });
    await expect(insert({ idempotency_key: key })).rejects.toMatchObject({
      code: '23505',
    });
  });
  it('rejects a lease_owner reused by another row (23505): the owner identifies the row', async () => {
    const owner = v7();
    await insert({ ...sending(), lease_owner: owner });
    await expect(
      insert({ ...sending(), lease_owner: owner }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'email_deliveries_lease_owner_key',
    });
  });
  it.each([
    'recipient_enc',
    'template',
    'locale',
    'idempotency_key',
    'public_id',
    'created_at',
  ])('app_user cannot UPDATE snapshot column %s (42501)', async (col) => {
    const id = await insertedId();
    await expect(
      app.query(
        `UPDATE email_deliveries SET ${col} = ${col} WHERE public_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('app_user can UPDATE the state columns', async () => {
    const id = await insertedId();
    const result = await app.query(
      `UPDATE email_deliveries SET state = 'SENT', attempts = 1, completed_at = now(), params_enc = NULL, updated_at = now() WHERE public_id = $1`,
      [id],
    );
    expect(result.rowCount).toBe(1);
  });
});

describe('email_deliveries lifecycle UPDATEs of spec §5.11 satisfy every CHECK (app_user)', () => {
  it('claim → SENT', async () => {
    const id = await insertedId();
    const owner = v7();
    expect((await claim(id, owner)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'SENDING', attempts: 1 });
    expect((await complete(id, owner)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'SENT', attempts: 1 });
  });
  it('claim → transient error releases the lease back to PENDING → claim again', async () => {
    const id = await insertedId();
    const first = v7();
    expect((await claim(id, first)).rowCount).toBe(1);
    expect((await release(id, first)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'PENDING', attempts: 1 });
    expect((await claim(id, v7())).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'SENDING', attempts: 2 });
  });
  it('claim → job FAILED (permanent error or last attempt)', async () => {
    const id = await insertedId();
    const owner = v7();
    expect((await claim(id, owner)).rowCount).toBe(1);
    expect((await jobFail(id, owner)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'FAILED', attempts: 1 });
  });
  it('an expired lease is re-claimed by a new owner; the old owner is fenced out', async () => {
    const id = await insertedId();
    const stale = v7();
    expect((await claim(id, stale, '-1 second')).rowCount).toBe(1);
    const fresh = v7();
    expect((await claim(id, fresh)).rowCount).toBe(1);
    expect((await complete(id, stale)).rowCount).toBe(0);
    expect((await complete(id, fresh)).rowCount).toBe(1);
  });
  it('reconcile → FAILED from PENDING once attempts reached the max', async () => {
    const max = 2;
    const id = await insertedId({ last_enqueued_at: LONG_AGO });
    for (let i = 0; i < max; i++) {
      const owner = v7();
      expect((await claim(id, owner)).rowCount).toBe(1);
      expect((await release(id, owner)).rowCount).toBe(1);
    }
    expect((await reconcileFail(id, max)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'FAILED', attempts: max });
  });
  it('reconcile → FAILED from SENDING with an expired lease once attempts reached the max', async () => {
    const id = await insertedId({ last_enqueued_at: LONG_AGO });
    expect((await claim(id, v7(), '-1 second')).rowCount).toBe(1);
    expect((await reconcileFail(id, 1)).rowCount).toBe(1);
    expect(await stateOf(id)).toEqual({ state: 'FAILED', attempts: 1 });
  });
  it('reconcile re-enqueue bumps the generation of a stuck PENDING row', async () => {
    const id = await insertedId({ last_enqueued_at: LONG_AGO });
    const { rows } = await reenqueue(id);
    expect(rows).toEqual([{ enqueue_generation: 1 }]);
  });
});

describe('email_deliveries privileges of other roles', () => {
  let owner: pg.Client;
  let relay: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    const at = { host: p.host, port: p.port, database: p.database };
    owner = new pg.Client({ ...at, ...p.owner });
    relay = new pg.Client({ ...at, ...p.relay });
    await owner.connect();
    await relay.connect();
  });
  afterAll(async () => {
    await relay?.end();
    await owner?.end();
  });

  it('app_relay holds no table or column privilege', async () => {
    const { rows } = await owner.query<{ table: boolean; column: boolean }>(
      `SELECT has_table_privilege('app_relay', 'public.email_deliveries',
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS table,
              has_any_column_privilege('app_relay', 'public.email_deliveries',
                'SELECT, INSERT, UPDATE, REFERENCES') AS column`,
    );
    expect(rows).toEqual([{ table: false, column: false }]);
    await expect(
      relay.query('SELECT 1 FROM email_deliveries LIMIT 1'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
