import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  return app.query(
    `INSERT INTO email_deliveries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING public_id`,
    Object.values(row),
  );
};

describe('email_deliveries constraints (spec §5.11, §5.16c) as app_user', () => {
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

  it('accepts a valid PENDING row', async () => {
    await expect(insert()).resolves.toBeDefined();
  });
  it.each([
    ['PENDING with lease_until', { lease_until: new Date() }],
    ['SENDING without owner', { state: 'SENDING', lease_until: new Date() }],
    ['SENT without completed_at', { state: 'SENT', params_enc: null }],
    ['PENDING with completed_at', { completed_at: new Date() }],
    [
      'FAILED still holding params',
      { state: 'FAILED', completed_at: new Date() },
    ],
    ['unknown last_error_code', { last_error_code: 'SMTP_EXPLODED' }],
    ['malformed locale', { locale: 'EN_us' }],
    [
      'idempotency key of another template',
      { idempotency_key: `reset-password:${v7()}` },
    ],
    [
      'unknown template',
      { template: 'newsletter', idempotency_key: `newsletter:${v7()}` },
    ],
    ['negative attempts', { attempts: -1 }],
  ])('rejects %s (23514)', async (_name, over) => {
    await expect(insert(over)).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a duplicate idempotency key (23505)', async () => {
    const key = `verify-email:${v7()}`;
    await insert({ idempotency_key: key });
    await expect(insert({ idempotency_key: key })).rejects.toMatchObject({
      code: '23505',
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
    const { rows } = await insert();
    await expect(
      app.query(
        `UPDATE email_deliveries SET ${col} = ${col} WHERE public_id = $1`,
        [rows[0].public_id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('app_user can UPDATE the state columns', async () => {
    const { rows } = await insert();
    await app.query(
      `UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, updated_at = now() WHERE public_id = $1`,
      [rows[0].public_id],
    );
  });
});
