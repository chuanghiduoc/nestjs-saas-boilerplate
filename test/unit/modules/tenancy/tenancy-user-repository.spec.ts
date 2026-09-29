import { describe, expect, it } from 'vitest';
import type { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import { TenancyUserVanishedError } from '../../../../src/modules/tenancy/errors.js';
import { SqlTenancyUserRepository } from '../../../../src/modules/tenancy/infra/sql/sql-tenancy-user.repository.js';

/** Db giả trả lần lượt kết quả cho từng câu; ghi lại SQL đã chạy. */
const fakeDb = (results: object[][]) => {
  const seen: string[] = [];
  const db = {
    execute: (sql: string) => {
      seen.push(sql);
      return Promise.resolve(results.shift() ?? []);
    },
  } as Pick<Db, 'execute'>;
  return { db: db as Db, seen };
};
const inTx = { inTransaction: () => true } as Pick<
  UnitOfWork,
  'inTransaction'
> as UnitOfWork;
const noTx = { inTransaction: () => false } as Pick<
  UnitOfWork,
  'inTransaction'
> as UnitOfWork;

describe('SqlTenancyUserRepository.upsertAndLock (spec SP3 §6.2, DB2-M10)', () => {
  it('targets the conflict column of the subject kind, never a bare ON CONFLICT', async () => {
    const { db, seen } = fakeDb([
      [],
      [{ id: '7', public_id: '0198c000-0000-7000-8000-000000000001' }],
    ]);
    await new SqlTenancyUserRepository(db, inTx).upsertAndLock({
      kind: 'EXTERNAL',
      externalSubject: 'sub-1',
    });
    expect(seen[0]).toMatch(/ON CONFLICT \(external_subject\) DO NOTHING/);
    expect(seen[1]).toMatch(/FOR NO KEY UPDATE/);
  });
  it('a row deleted between the upsert and the lock is a named error, never a retry', async () => {
    const { db, seen } = fakeDb([[], []]);
    await expect(
      new SqlTenancyUserRepository(db, inTx).upsertAndLock({
        kind: 'AUTH_USER',
        authUserId: '0198c000-0000-7000-8000-000000000002',
      }),
    ).rejects.toBeInstanceOf(TenancyUserVanishedError);
    expect(seen).toHaveLength(2);
  });
  it('refuses to run outside a transaction (the lock would be released at once)', async () => {
    const { db } = fakeDb([]);
    await expect(
      new SqlTenancyUserRepository(db, noTx).upsertAndLock({
        kind: 'EXTERNAL',
        externalSubject: 's',
      }),
    ).rejects.toThrow(/inside UnitOfWork\.run/);
  });
});

describe('SqlTenancyUserRepository.deleteById', () => {
  it('refuses to run outside a transaction and issues no SQL', async () => {
    const { db, seen } = fakeDb([]);
    await expect(
      new SqlTenancyUserRepository(db, noTx).deleteById('7'),
    ).rejects.toThrow(/deleteById must run inside UnitOfWork\.run/);
    expect(seen).toHaveLength(0);
  });
  it('deletes the row by id inside a transaction', async () => {
    const { db, seen } = fakeDb([[]]);
    await new SqlTenancyUserRepository(db, inTx).deleteById('7');
    expect(seen).toEqual(['DELETE FROM tenancy_users WHERE id = ?']);
  });
});
