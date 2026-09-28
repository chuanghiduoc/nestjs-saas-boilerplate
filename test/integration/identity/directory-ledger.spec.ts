import { Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { PgRegistrationLedger } from '../../../src/modules/identity/infra/better-auth/pg-registration-ledger.js';
import {
  hasAdminRole,
  isBanned,
} from '../../../src/modules/identity/ports/identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({
  providers: [...authPoolProviders, PgIdentityDirectory, PgRegistrationLedger],
})
class M {}

describe('IdentityDirectory + RegistrationLedger over the auth_user pool', () => {
  let app: INestApplication;
  let owner: pg.Client;
  const insertUser = async (
    email: string,
    createdAgoSec = 0,
    role: string | null = null,
  ) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at) VALUES ('N', $1, true, $2, now() - make_interval(secs => $3), now()) RETURNING id`,
        [email, role, createdAgoSec],
      )
    ).rows[0]!.id;
  beforeAll(async () => {
    app = await createTestApp([M]);
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
    await owner?.end();
    await app?.close();
  });

  it('maps every column of a default row, finds it by id and by normalized email', async () => {
    const email = `d-${v7()}@example.test`;
    const id = await insertUser(email, 0, 'user,admin');
    const { rows } = await owner.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM auth."user" WHERE id = $1`,
      [id],
    );
    const dir = app.get(PgIdentityDirectory);
    const expected = {
      id,
      email,
      name: 'N',
      emailVerified: true,
      role: 'user,admin',
      banned: false,
      banExpires: null,
      twoFactorEnabled: false,
      createdAt: rows[0]!.created_at,
      updatedAt: rows[0]!.updated_at,
    };
    expect(await dir.findUser(id)).toEqual(expected);
    expect(await dir.findUserByEmail(email)).toEqual(expected);
    expect(await dir.findUser(v7())).toBeUndefined();
    expect(
      await dir.findUserByEmail(`missing-${v7()}@example.test`),
    ).toBeUndefined();
    expect(hasAdminRole('user,admin')).toBe(true);
    expect(hasAdminRole('administrator')).toBe(false);
    expect(hasAdminRole(null)).toBe(false);
  });
  // Cùng với dòng mặc định (verified=T, banned=F, 2FA=F), hai dòng này làm mọi cặp cột boolean khác
  // giá trị ở ít nhất một dòng, nên đảo bất kỳ hai cột nào trong mapping đều bị bắt.
  it.each([
    {
      label: 'banned admin with a ban expiry',
      name: 'Banned Admin',
      role: 'admin',
      banned: true,
      banExpires: new Date('2030-01-02T03:04:05.000Z'),
      twoFactorEnabled: false,
    },
    {
      label: 'unbanned user with 2FA on',
      name: 'Two Factor',
      role: 'user',
      banned: false,
      banExpires: null,
      twoFactorEnabled: true,
    },
  ])(
    'maps true-valued flags, ban expiry and role without swapping columns: $label',
    async ({ name, role, banned, banExpires, twoFactorEnabled }) => {
      const email = `b-${v7()}@example.test`;
      const { rows } = await owner.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO auth."user" (name, email, email_verified, role, banned, ban_expires, two_factor_enabled, created_at, updated_at)
         VALUES ($1, $2, false, $3, $4, $5, $6, now() - interval '1 hour', now())
         RETURNING id, created_at, updated_at`,
        [name, email, role, banned, banExpires, twoFactorEnabled],
      );
      const row = rows[0]!;
      const user = await app.get(PgIdentityDirectory).findUser(row.id);
      expect(user).toEqual({
        id: row.id,
        email,
        name,
        emailVerified: false,
        role,
        banned,
        banExpires,
        twoFactorEnabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      expect(user!.createdAt.getTime()).toBeLessThan(user!.updatedAt.getTime());
      expect(hasAdminRole(user!.role)).toBe(role === 'admin');
      expect(isBanned(user!, new Date('2029-12-31T00:00:00Z'))).toBe(banned);
      expect(isBanned(user!, new Date('2030-01-03T00:00:00Z'))).toBe(false);
    },
  );
  it('isBanned honours banExpires', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    const u = {
      id: 'x',
      email: 'e',
      name: 'n',
      emailVerified: true,
      role: null,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    };
    expect(isBanned({ ...u, banned: true, banExpires: null }, now)).toBe(true);
    expect(
      isBanned(
        { ...u, banned: true, banExpires: new Date('2026-09-28T00:00:00Z') },
        now,
      ),
    ).toBe(true);
    expect(
      isBanned(
        { ...u, banned: true, banExpires: new Date('2026-09-26T00:00:00Z') },
        now,
      ),
    ).toBe(false);
    expect(isBanned({ ...u, banned: false, banExpires: null }, now)).toBe(
      false,
    );
  });
  it('ledger lists unmarked users older than the grace, marks them once, and reports the oldest age', async () => {
    const old = await insertUser(`o-${v7()}@example.test`, 600);
    const young = await insertUser(`y-${v7()}@example.test`, 0);
    const ledger = app.get(PgRegistrationLedger);
    const ids = await ledger.unmarked(300, 1000);
    expect(ids).toContain(old);
    expect(ids).not.toContain(young);
    expect(await ledger.oldestUnmarkedAgeSec()).toBeGreaterThanOrEqual(600);
    expect(await ledger.mark([old])).toBe(1);
    expect(await ledger.mark([old])).toBe(0);
    expect(await ledger.unmarked(300, 1000)).not.toContain(old);
    expect(await ledger.mark([])).toBe(0);
    // Chỉ dòng chưa đánh dấu được tính: `old` đã có marker, `young` thì chưa.
    expect(await ledger.mark([old, young])).toBe(1);
  });
  it('findUsers reads a whole page in one query and skips unknown ids; more than the batch max is refused', async () => {
    const a = await insertUser(`fa-${v7()}@example.test`);
    const b = await insertUser(`fb-${v7()}@example.test`);
    const dir = app.get(PgIdentityDirectory);
    const found = await dir.findUsers([a, b, v7()]);
    expect(found.map((u) => u.id).sort()).toEqual([a, b].sort());
    expect(await dir.findUsers([])).toEqual([]);
    await expect(
      dir.findUsers(Array.from({ length: 101 }, () => v7())),
    ).rejects.toThrow(/AUTH_DIRECTORY_BATCH_MAX/);
  });
});
