import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, UnitOfWork } from '../../../../core/database/index.js';
import { TenancyUserVanishedError } from '../../errors.js';
import {
  TenancyUserRepository,
  type TenancySubject,
  type TenancyUserRef,
} from '../../ports/tenancy-user-repository.js';

const Ref = z
  .object({ id: z.string(), public_id: z.string() })
  .transform((r) => ({ id: r.id, publicId: r.public_id }));
/** Cột đích theo loại subject (spec SP3 §6.2): không bao giờ `ON CONFLICT` không cột. */
const columnOf = (
  s: TenancySubject,
): { column: 'auth_user_id' | 'external_subject'; value: string } =>
  s.kind === 'AUTH_USER'
    ? { column: 'auth_user_id', value: s.authUserId }
    : { column: 'external_subject', value: s.externalSubject };

@Injectable()
export class SqlTenancyUserRepository extends TenancyUserRepository {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {
    super();
  }

  async find(s: TenancySubject): Promise<TenancyUserRef | undefined> {
    const { column, value } = columnOf(s);
    const rows = await this.db.execute(
      `SELECT id::text AS id, public_id::text AS public_id FROM tenancy_users WHERE ${column} = ?`,
      [value],
    );
    return rows[0] ? Ref.parse(rows[0]) : undefined;
  }

  /**
   * Requires READ COMMITTED: the `SELECT … FOR NO KEY UPDATE` after `ON CONFLICT DO NOTHING`
   * must see a row committed by a concurrent inserter, which needs a fresh per-statement snapshot.
   * Under REPEATABLE READ/SERIALIZABLE that row stays outside the snapshot and the call fails
   * (serialization error or `TenancyUserVanishedError`).
   */
  async upsertAndLock(s: TenancySubject): Promise<TenancyUserRef> {
    if (!this.uow.inTransaction())
      throw new Error(
        'TenancyUserRepository.upsertAndLock must run inside UnitOfWork.run',
      );
    const { column, value } = columnOf(s);
    await this.db.execute(
      `INSERT INTO tenancy_users (${column}) VALUES (?) ON CONFLICT (${column}) DO NOTHING`,
      [value],
    );
    const rows = await this.db.execute(
      `SELECT id::text AS id, public_id::text AS public_id FROM tenancy_users WHERE ${column} = ? FOR NO KEY UPDATE`,
      [value],
    );
    if (!rows[0]) throw new TenancyUserVanishedError();
    return Ref.parse(rows[0]);
  }

  async deleteById(id: string): Promise<void> {
    if (!this.uow.inTransaction())
      throw new Error(
        'TenancyUserRepository.deleteById must run inside UnitOfWork.run',
      );
    await this.db.execute('DELETE FROM tenancy_users WHERE id = ?', [id]);
  }
}
