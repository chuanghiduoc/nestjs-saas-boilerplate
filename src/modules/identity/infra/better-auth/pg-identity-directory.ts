import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import {
  IdentityDirectory,
  type DirectoryUser,
} from '../../ports/identity-directory.js';
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
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {
    super();
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
}
