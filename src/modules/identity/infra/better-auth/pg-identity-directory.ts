import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import {
  IdentityDirectory,
  type DirectoryUser,
} from '../../ports/identity-directory.js';
import { identityConfig, type IdentityConfig } from '../../identity.config.js';
import { AUTH_POOL } from './auth-pool.provider.js';

/** `banned`/`two_factor_enabled` là NOT NULL DEFAULT false (Task 26 fix round 1): NULL là lệch schema, parse ném lỗi. */
const Row = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  email_verified: z.boolean(),
  role: z.string().nullable(),
  banned: z.boolean(),
  ban_expires: z.date().nullable(),
  two_factor_enabled: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});
/** `auth."user".id` là uuid. */
const UserId = z.uuid();
const COLUMNS =
  'id, email, name, email_verified, role, banned, ban_expires, two_factor_enabled, created_at, updated_at';
const toUser = (r: z.infer<typeof Row>): DirectoryUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  emailVerified: r.email_verified,
  role: r.role,
  banned: r.banned,
  banExpires: r.ban_expires,
  twoFactorEnabled: r.two_factor_enabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class PgIdentityDirectory extends IdentityDirectory {
  private readonly batchMax: number;
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
  ) {
    super();
    this.batchMax = identity.directoryBatchMax;
  }
  async findUser(id: string): Promise<DirectoryUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth."user" WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUser(Row.parse(rows[0])) : undefined;
  }
  async findUserByEmail(
    normalizedEmail: string,
  ): Promise<DirectoryUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth."user" WHERE email = $1`,
      [normalizedEmail],
    );
    return rows[0] ? toUser(Row.parse(rows[0])) : undefined;
  }
  async findUsers(ids: readonly string[]): Promise<DirectoryUser[]> {
    if (ids.length === 0) return [];
    if (ids.length > this.batchMax)
      throw new Error(
        `IdentityDirectory.findUsers accepts at most ${this.batchMax} ids (AUTH_DIRECTORY_BATCH_MAX), got ${ids.length}`,
      );
    // Kiểm ở port (sau trần lô, nên danh sách lỗi bị chặn độ dài): id sai là lỗi của caller, không để lọt thành `22P02`.
    const invalid = ids.filter((id) => !UserId.safeParse(id).success);
    if (invalid.length > 0)
      throw new Error(
        `IdentityDirectory.findUsers: invalid user id(s), expected UUID: ${JSON.stringify(invalid)}`,
      );
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth."user" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return z.array(Row).parse(rows).map(toUser);
  }
}
