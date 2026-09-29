import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';
import { withAppClient } from '../../../support/tenancy-seed.js';

const ACTOR = 'test-actor';
/** Giới hạn độ dài của spec §6.2 (key ≤ 100, reason 1..500, changed_by 1..255). */
const KEY_MAX = 100;
const REASON_MAX = 500;
const insert = (
  c: pg.Client,
  key: string,
  killed: boolean,
  reason: string | null,
  actor = ACTOR,
) =>
  c.query(
    'INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ($1, $2, $3, $4)',
    [key, killed, reason, actor],
  );
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('kill_switches table (spec SP6 §6.2, §6.9)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.query(
      `DELETE FROM kill_switches WHERE key LIKE 'fixture.table_%'`,
    );
    await owner?.end();
  });

  it('app_user inserts and reads a row; version starts at 1', async () => {
    await withAppClient(async (c) => {
      await insert(c, 'fixture.table_ok', true, 'maintenance window');
      const { rows } = await c.query(
        'SELECT killed, reason, changed_by, version FROM kill_switches WHERE key = $1',
        ['fixture.table_ok'],
      );
      expect(rows).toEqual([
        {
          killed: true,
          reason: 'maintenance window',
          changed_by: ACTOR,
          version: 1,
        },
      ]);
    });
  });
  it.each([
    'nodot',
    'Upper.case',
    'a..b',
    '1a.b',
    'a.b-c',
    `a.${'b'.repeat(KEY_MAX - 1)}`,
  ])('the key CHECK refuses %j', async (key) => {
    await withAppClient(async (c) => {
      expect(await failure(insert(c, key, false, null))).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_key_ck',
      });
    });
  });
  it('a killed switch needs a trimmed reason of 1..500 characters; changed_by is 1..255 characters', async () => {
    await withAppClient(async (c) => {
      expect(
        await failure(insert(c, 'fixture.table_noreason', true, null)),
      ).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_reason_required_ck',
      });
      for (const reason of [' padded ', '', 'x'.repeat(REASON_MAX + 1)])
        expect(
          await failure(insert(c, 'fixture.table_reason', false, reason)),
        ).toMatchObject({
          code: '23514',
          constraint: 'kill_switches_reason_ck',
        });
      expect(
        await failure(insert(c, 'fixture.table_actor', false, null, '')),
      ).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_changed_by_ck',
      });
    });
  });
  it('app_user updates only killed, reason, changed_by, version, updated_at, never deletes, and version stays >= 1', async () => {
    await withAppClient(async (c) => {
      await insert(c, 'fixture.table_upd', false, null);
      await c.query(
        `UPDATE kill_switches SET killed = true, reason = 'r', version = version + 1, updated_at = now() WHERE key = $1`,
        ['fixture.table_upd'],
      );
      for (const sql of [
        `UPDATE kill_switches SET key = 'fixture.table_renamed' WHERE key = 'fixture.table_upd'`,
        `UPDATE kill_switches SET created_at = now() WHERE key = 'fixture.table_upd'`,
        `DELETE FROM kill_switches WHERE key = 'fixture.table_upd'`,
      ])
        expect(await failure(c.query(sql)), sql).toMatchObject({
          code: '42501',
        });
      expect(
        await failure(
          c.query(
            `UPDATE kill_switches SET version = 0 WHERE key = 'fixture.table_upd'`,
          ),
        ),
      ).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_version_ck',
      });
    });
  });
});
