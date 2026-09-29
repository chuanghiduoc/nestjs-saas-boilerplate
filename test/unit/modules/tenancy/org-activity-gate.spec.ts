import { describe, expect, it } from 'vitest';
import type { Db } from '../../../../src/core/database/index.js';
import { TenancyOrgActivityGate } from '../../../../src/modules/tenancy/application/org-activity.gate.js';

/** Db giả: mỗi lần gọi trả về `rows` (hoặc lỗi của `fail`). */
const fakeDb = (rows: object[], fail?: Error): Db =>
  ({
    execute: () => (fail ? Promise.reject(fail) : Promise.resolve(rows)),
  }) as Pick<Db, 'execute'> as Db;

describe('TenancyOrgActivityGate fails closed (spec SP3 §9.4, core OrgActivityGate contract)', () => {
  it('a DB error propagates: never read as ACTIVE, DELETED or GONE', async () => {
    const boom = new Error('connection terminated unexpectedly');
    await expect(
      new TenancyOrgActivityGate(fakeDb([], boom)).check(),
    ).rejects.toBe(boom);
  });
  it('an unparseable deleted_at throws instead of guessing ACTIVE', async () => {
    await expect(
      new TenancyOrgActivityGate(
        fakeDb([{ deleted_at: 'not a date' }]),
      ).check(),
    ).rejects.toThrow();
  });
  it('maps the row to ACTIVE, DELETED (with the timestamp) and GONE', async () => {
    expect(
      await new TenancyOrgActivityGate(fakeDb([{ deleted_at: null }])).check(),
    ).toEqual({ kind: 'ACTIVE' });
    expect(await new TenancyOrgActivityGate(fakeDb([])).check()).toEqual({
      kind: 'GONE',
    });
    expect(
      await new TenancyOrgActivityGate(
        fakeDb([{ deleted_at: '2026-09-29 10:00:00+00' }]),
      ).check(),
    ).toEqual({
      kind: 'DELETED',
      deletedAt: new Date('2026-09-29T10:00:00Z'),
    });
  });
});
