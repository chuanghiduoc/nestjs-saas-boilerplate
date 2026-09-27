import { Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authPoolProviders,
  AUTH_POOL,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
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

  it('finds a user by id and by normalized email', async () => {
    const email = `d-${v7()}@example.test`;
    const id = await insertUser(email, 0, 'user,admin');
    const dir = app.get(PgIdentityDirectory);
    expect(await dir.findUser(id)).toMatchObject({
      id,
      email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
    });
    expect((await dir.findUserByEmail(email))?.id).toBe(id);
    expect(await dir.findUser(v7())).toBeUndefined();
    expect(hasAdminRole('user,admin')).toBe(true);
    expect(hasAdminRole('administrator')).toBe(false);
    expect(hasAdminRole(null)).toBe(false);
  });
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
    expect(app.get(AUTH_POOL)).toBeDefined();
  });
});
