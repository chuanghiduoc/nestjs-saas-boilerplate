import { Logger } from '@nestjs/common';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import {
  betterAuth,
  type BetterAuthOptions,
  type DBAdapter,
} from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import {
  accountAad,
  withAccountCipher,
} from '../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';

type TokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
};

describe('withAccountCipher over the real Kysely adapter (auth_user, schema auth)', () => {
  let pool: pg.Pool;
  let db: Kysely<Record<string, never>>;
  const cipher = new FieldCipher(
    { k1: randomBytes(32).toString('base64') },
    'k1',
  );
  const makeAuth = (wrap: boolean, validateSchema?: boolean) => {
    let inner: DBAdapter | undefined;
    const auth = betterAuth({
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      advanced: {
        database: {
          generateId: 'uuid',
          ...(validateSchema === undefined ? {} : { validateSchema }),
        },
      },
      database: (o: BetterAuthOptions) => {
        inner = kyselyAdapter(db, { type: 'postgres', transaction: true })(o);
        return wrap ? withAccountCipher(inner, cipher) : inner;
      },
    });
    return {
      auth,
      inner: () => {
        if (!inner) throw new Error('database factory was not called');
        return inner;
      },
    };
  };
  const tokens = async (id: string): Promise<TokenRow> => {
    const raw = await pool.query<TokenRow>(
      'SELECT access_token, refresh_token, id_token FROM account WHERE id = $1',
      [id],
    );
    const row = raw.rows[0];
    if (!row) throw new Error('account row was not found');
    return row;
  };
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
    const ctx = await makeAuth(true).auth.$context;
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
        idToken: 'eyJ.plain-id',
      });
      const row = await tokens(acct.id);
      expect(FieldCipher.isCiphertext(String(row.access_token))).toBe(true);
      expect(FieldCipher.isCiphertext(String(row.refresh_token))).toBe(true);
      expect(FieldCipher.isCiphertext(String(row.id_token))).toBe(true);
      expect(JSON.stringify(row)).not.toContain('plain');
      await ctx.internalAdapter.updateAccount(acct.id, {
        refreshToken: 'rt-rotated',
        idToken: 'eyJ.rotated-id',
      });
      const read = await ctx.internalAdapter.findAccounts(user.id);
      expect(read[0]).toMatchObject({
        accessToken: 'ya29.plain',
        refreshToken: 'rt-rotated',
        idToken: 'eyJ.rotated-id',
      });
      expect(JSON.stringify(await tokens(acct.id))).not.toContain('rotated');
    } finally {
      await ctx.internalAdapter.deleteUser(user.id);
    }
  });

  it('encrypts inside a Better Auth transaction (createOAuthUser)', async () => {
    const built = makeAuth(true);
    const ctx = await built.auth.$context;
    const transaction = vi.spyOn(built.inner(), 'transaction');
    const accountId = v7();
    const { user, account } = await ctx.internalAdapter.createOAuthUser(
      { email: `o-${v7()}@example.test`, name: 'O', emailVerified: true },
      {
        providerId: 'google',
        accountId,
        accessToken: 'ya29.tx-plain',
        idToken: 'eyJ.tx-plain-id',
      },
    );
    try {
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(account).toMatchObject({
        accessToken: 'ya29.tx-plain',
        idToken: 'eyJ.tx-plain-id',
      });
      const row = await tokens(account.id);
      expect(JSON.stringify(row)).not.toContain('plain');
      expect(
        cipher.decrypt(
          String(row.id_token),
          accountAad('idToken', 'google', accountId),
        ),
      ).toBe('eyJ.tx-plain-id');
    } finally {
      await ctx.internalAdapter.deleteUser(user.id);
    }
  });

  it('keeps the Kysely schema check wired exactly as on the unwrapped adapter', async () => {
    for (const validateSchema of [undefined, false]) {
      const wrapped = await makeAuth(true, validateSchema).auth.$context;
      const plain = await makeAuth(false, validateSchema).auth.$context;
      expect(typeof wrapped.checkSchema).toBe(typeof plain.checkSchema);
      expect(typeof wrapped.explicitSchemaCheck).toBe(
        typeof plain.explicitSchemaCheck,
      );
      expect(wrapped.explicitSchemaCheck?.source).toBe('database');
      await expect(wrapped.explicitSchemaCheck?.()).resolves.toBeUndefined();
    }
    expect(typeof (await makeAuth(true).auth.$context).checkSchema).toBe(
      'function',
    );
  });

  it('deletes an account whose token can no longer be decrypted (retired kid)', async () => {
    const ctx = await makeAuth(true).auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `d-${v7()}@example.test`, name: 'D', emailVerified: true },
      { method: 'email-password' },
    );
    try {
      const accountId = v7();
      const acct = await ctx.internalAdapter.createAccount({
        userId: user.id,
        providerId: 'google',
        accountId,
        accessToken: 'ya29.retired',
      });
      const retired = new FieldCipher(
        { old: randomBytes(32).toString('base64') },
        'old',
      );
      await pool.query('UPDATE account SET access_token = $1 WHERE id = $2', [
        retired.encrypt(
          'ya29.retired',
          accountAad('accessToken', 'google', accountId),
        ),
        acct.id,
      ]);
      await ctx.internalAdapter.deleteAccount(acct.id);
      const left = await pool.query('SELECT 1 FROM account WHERE id = $1', [
        acct.id,
      ]);
      expect(left.rowCount).toBe(0);
    } finally {
      await ctx.internalAdapter.deleteUser(user.id);
    }
  });

  it('list-accounts still answers for a retired-kid token; get-access-token still refuses it', async () => {
    const auth = betterAuth({
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      advanced: { database: { generateId: 'uuid' } },
      emailAndPassword: { enabled: true },
      socialProviders: {
        google: { clientId: 'test-client', clientSecret: 'test-secret' },
      },
      database: (o: BetterAuthOptions) =>
        withAccountCipher(
          kyselyAdapter(db, { type: 'postgres', transaction: true })(o),
          cipher,
        ),
    });
    const ctx = await auth.$context;
    const signUp = await auth.api.signUpEmail({
      body: {
        email: `l-${v7()}@example.test`,
        password: 'correct-horse-battery',
        name: 'L',
      },
      returnHeaders: true,
    });
    const userId = signUp.response.user.id;
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const headers = new Headers({ cookie });
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const accountId = v7();
      const acct = await ctx.internalAdapter.createAccount({
        userId,
        providerId: 'google',
        accountId,
        accessToken: 'ya29.retired',
      });
      const retired = new FieldCipher(
        { old: randomBytes(32).toString('base64') },
        'old',
      );
      await pool.query('UPDATE account SET access_token = $1 WHERE id = $2', [
        retired.encrypt(
          'ya29.retired',
          accountAad('accessToken', 'google', accountId),
        ),
        acct.id,
      ]);
      const listed = await auth.api.listUserAccounts({ headers });
      expect(listed.map((a) => a.id)).toContain(acct.id);
      expect(JSON.stringify(listed)).not.toContain('ya29');
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'auth_account_token_undecryptable',
      );
      await expect(
        auth.api.getAccessToken({ body: { accountId: acct.id }, headers }),
      ).rejects.toMatchObject({
        body: { code: 'FAILED_TO_GET_ACCESS_TOKEN' },
      });
    } finally {
      await ctx.internalAdapter.deleteUser(userId);
    }
  });
});
