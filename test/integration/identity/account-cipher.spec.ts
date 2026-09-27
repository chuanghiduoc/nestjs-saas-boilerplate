import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { withAccountCipher } from '../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';

describe('withAccountCipher over the real Kysely adapter (auth_user, schema auth)', () => {
  let pool: pg.Pool;
  let db: Kysely<Record<string, never>>;
  const cipher = new FieldCipher(
    { k1: randomBytes(32).toString('base64') },
    'k1',
  );
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    db = new Kysely({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    });
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('stores only ciphertext and returns plaintext to Better Auth', async () => {
    const auth = betterAuth({
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      advanced: { database: { generateId: 'uuid' } },
      database: (o: BetterAuthOptions) =>
        withAccountCipher(
          kyselyAdapter(db, { type: 'postgres', transaction: true })(o),
          cipher,
        ),
    });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `c-${v7()}@example.test`, name: 'C', emailVerified: true },
      { method: 'email-password' },
    );
    try {
      const acct = await ctx.internalAdapter.createAccount({
        userId: user.id,
        providerId: 'google',
        accountId: v7(),
        accessToken: 'ya29.plain',
        refreshToken: 'rt-plain',
      });
      const raw = await pool.query<{
        access_token: string;
        refresh_token: string;
      }>('SELECT access_token, refresh_token FROM account WHERE id = $1', [
        acct.id,
      ]);
      const row = raw.rows[0];
      if (!row) throw new Error('created account was not found');
      expect(FieldCipher.isCiphertext(row.access_token)).toBe(true);
      expect(FieldCipher.isCiphertext(row.refresh_token)).toBe(true);
      expect(JSON.stringify(raw.rows[0])).not.toContain('plain');
      await ctx.internalAdapter.updateAccount(acct.id, {
        refreshToken: 'rt-rotated',
      });
      const read = await ctx.internalAdapter.findAccounts(user.id);
      expect(read[0]).toMatchObject({
        accessToken: 'ya29.plain',
        refreshToken: 'rt-rotated',
      });
    } finally {
      await ctx.internalAdapter.deleteUser(user.id);
    }
  });
});
