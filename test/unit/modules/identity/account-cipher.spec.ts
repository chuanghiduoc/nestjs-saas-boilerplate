import type { Where } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { randomBytes } from 'node:crypto';
import {
  registerSchemaCheck,
  runtimeSchemaCheckFor,
  schemaCheckFor,
  type SchemaCheck,
} from '@better-auth/core/db/internal';
import { describe, expect, it, vi } from 'vitest';
import {
  FieldCipher,
  FieldCipherError,
} from '../../../../src/core/security/index.js';
import {
  AccountCipherError,
  accountAad,
  withAccountCipher,
} from '../../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';

type Row = Record<string, unknown>;
const cipher = new FieldCipher(
  { k1: randomBytes(32).toString('base64') },
  'k1',
);
const setup = () => {
  const store: Record<string, Row[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const inner = memoryAdapter(store)({});
  const findOne = vi.spyOn(inner, 'findOne');
  const update = vi.spyOn(inner, 'update');
  const raw = (id: unknown): Row => {
    const r = store.account?.find((x) => x.id === id);
    if (!r) throw new Error(`no account row ${String(id)}`);
    return r;
  };
  return { store, raw, findOne, update, a: withAccountCipher(inner, cipher) };
};
const byId = (id: unknown): Where[] => [{ field: 'id', value: String(id) }];
const account = (extra: Row = {}): Row => ({
  providerId: 'google',
  accountId: 'g1',
  userId: 'u1',
  ...extra,
});

const captureError = (read: () => unknown): unknown => {
  try {
    read();
  } catch (err) {
    return err;
  }
  throw new Error('expected the read to throw');
};

describe('withAccountCipher', () => {
  it('uses the exact field-specific AAD contract', () => {
    expect(accountAad('accessToken', 'google', 'g1')).toBe(
      'auth.account:access_token:-:google/g1',
    );
    expect(accountAad('refreshToken', 'google', 'g1')).toBe(
      'auth.account:refresh_token:-:google/g1',
    );
    expect(accountAad('idToken', 'google', 'g1')).toBe(
      'auth.account:id_token:-:google/g1',
    );
  });
  it('passes password-only updateMany through without extra reads', async () => {
    const { a, raw, findOne } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ providerId: 'credential', password: 'old' }),
    });
    findOne.mockClear();
    expect(
      await a.updateMany({
        model: 'account',
        where: [
          { field: 'userId', value: 'u1' },
          { field: 'providerId', value: 'credential' },
          { field: 'accountId', value: 'g1' },
        ],
        update: { password: 'new' },
      }),
    ).toBe(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(raw(c.id).password).toBe('new');
  });
  it('accepts unchanged identities but rejects changes before writing', async () => {
    const { a, update, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'old' }),
    });
    expect(
      await a.update({
        model: 'account',
        where: byId(c.id),
        update: { providerId: 'google', accessToken: 'new' },
      }),
    ).toMatchObject({ accessToken: 'new' });
    await a.update({
      model: 'account',
      where: byId(c.id),
      update: { providerId: 'google', accountId: 'g1' },
    });
    update.mockClear();
    await expect(
      a.update({
        model: 'account',
        where: byId(c.id),
        update: { providerId: 'other', accessToken: 'bad' },
      }),
    ).rejects.toThrow(AccountCipherError);
    expect(update).not.toHaveBeenCalled();
    expect(raw(c.id).providerId).toBe('google');
  });
  it('decrypts user joins without changing stored tokens or the joined user', async () => {
    const { a, raw } = setup();
    const u = await a.create<Row>({
      model: 'user',
      data: { email: 'join@example.test', name: 'U', emailVerified: false },
    });
    const c = await a.create<Row>({
      model: 'account',
      data: account({ userId: u.id, idToken: 'jwt' }),
    });
    const encrypted = raw(c.id).idToken;
    expect(
      await a.findOne({
        model: 'user',
        where: byId(u.id),
        join: { account: true },
      }),
    ).toMatchObject({ name: 'U', account: [{ idToken: 'jwt' }] });
    expect(
      await a.findMany({ model: 'user', join: { account: true } }),
    ).toMatchObject([{ account: [{ idToken: 'jwt' }] }]);
    expect(
      await a.findMany({ model: 'account', join: { user: true } }),
    ).toMatchObject([{ idToken: 'jwt', user: { name: 'U' } }]);
    expect(raw(c.id).idToken).toBe(encrypted);
  });
  it('encrypts updateMany tokens only by exact id and validates ciphertext before writing', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ idToken: 'jwt' }),
    });
    await expect(
      a.updateMany({
        model: 'account',
        where: [{ field: 'userId', value: 'u1' }],
        update: { idToken: 'bad' },
      }),
    ).rejects.toThrow(AccountCipherError);
    expect(
      await a.updateMany({
        model: 'account',
        where: byId(c.id),
        update: { idToken: 'rotated' },
      }),
    ).toBe(1);
    const encrypted = raw(c.id).idToken;
    expect(
      cipher.decrypt(String(encrypted), accountAad('idToken', 'google', 'g1')),
    ).toBe('rotated');
    const copied = cipher.encrypt(
      'secret',
      accountAad('accessToken', 'google', 'g1'),
    );
    await expect(
      a.updateMany({
        model: 'account',
        where: byId(c.id),
        update: { idToken: copied },
      }),
    ).rejects.toThrow(FieldCipherError);
    expect(raw(c.id).idToken).toBe(encrypted);
  });
  it('preserves unknown-kid errors and never includes tokens in error messages', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({ model: 'account', data: account() });
    const other = new FieldCipher(
      { k2: randomBytes(32).toString('base64') },
      'k2',
    );
    const token = other.encrypt(
      'private-token',
      accountAad('accessToken', 'google', 'g1'),
    );
    raw(c.id).accessToken = token;
    const row = await a.findOne<Row>({ model: 'account', where: byId(c.id) });
    if (!row) throw new Error('account row was not returned');
    const failure = captureError(() => row.accessToken);
    expect(failure).toBeInstanceOf(FieldCipherError);
    expect(failure).toMatchObject({ code: 'UNKNOWN_KID' });
    expect(String(failure)).not.toContain(token);
    expect(String(failure)).not.toContain('private-token');
    expect(() => ({ ...row })).toThrow(FieldCipherError);
    expect(() => JSON.stringify(row)).toThrow(FieldCipherError);
  });
  it('rejects tampering and ciphertext copied across token fields', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'private-token' }),
    });
    const encrypted = String(raw(c.id).accessToken);
    raw(c.id).refreshToken = encrypted;
    const copied = await a.findOne<Row>({
      model: 'account',
      where: byId(c.id),
    });
    expect(copied?.accessToken).toBe('private-token');
    expect(captureError(() => copied?.refreshToken)).toMatchObject({
      code: 'INVALID_CIPHERTEXT',
    });
    delete raw(c.id).refreshToken;
    const parts = encrypted.split('.');
    const tag = parts[4];
    if (!tag) throw new Error('missing authentication tag');
    parts[4] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    raw(c.id).accessToken = parts.join('.');
    const [tampered] = await a.findMany<Row>({ model: 'account' });
    expect(() => tampered?.accessToken).toThrow(FieldCipherError);
  });
  it('encrypts empty strings and rejects invalid token types before persistence', async () => {
    const { a, raw, store } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({
        accessToken: '',
        refreshToken: null,
        idToken: undefined,
      }),
    });
    expect(FieldCipher.isCiphertext(String(raw(c.id).accessToken))).toBe(true);
    expect(c.accessToken).toBe('');
    await expect(
      a.create({ model: 'account', data: account({ accessToken: 123 }) }),
    ).rejects.toThrow(AccountCipherError);
    expect(store.account).toHaveLength(1);
  });
  it('fails on missing identities and unsafe token write selectors', async () => {
    const { a, update } = setup();
    await expect(
      a.create({ model: 'account', data: { accessToken: 'secret' } }),
    ).rejects.toThrow(AccountCipherError);
    await expect(
      a.update({
        model: 'account',
        where: byId('missing'),
        update: { accessToken: 'secret' },
      }),
    ).rejects.toThrow(AccountCipherError);
    const selectors: Where[][] = [
      [],
      [{ field: 'id', value: 'a', operator: 'ne' }],
      [{ field: 'id', value: ['a'], operator: 'in' }],
      [{ field: 'id', value: 'a', mode: 'insensitive' }],
      [...byId('a'), ...byId('b')],
    ];
    for (const where of selectors)
      await expect(
        a.update({
          model: 'account',
          where,
          update: { accessToken: 'secret' },
        }),
      ).rejects.toThrow(AccountCipherError);
    expect(update).not.toHaveBeenCalled();
  });
  it('wraps transaction reads and rotation, preserving rollback and result', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ refreshToken: 'original' }),
    });
    await expect(
      a.transaction(async (trx) => {
        await trx.update({
          model: 'account',
          where: byId(c.id),
          update: { refreshToken: 'rolled-back' },
        });
        expect(
          await trx.findOne({ model: 'account', where: byId(c.id) }),
        ).toMatchObject({ refreshToken: 'rolled-back' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      cipher.decrypt(
        String(raw(c.id).refreshToken),
        accountAad('refreshToken', 'google', 'g1'),
      ),
    ).toBe('original');
    expect(
      await a.transaction(async (trx) =>
        trx.update({
          model: 'account',
          where: byId(c.id),
          update: { refreshToken: 'committed' },
        }),
      ),
    ).toMatchObject({ refreshToken: 'committed' });
    expect(
      cipher.decrypt(
        String(raw(c.id).refreshToken),
        accountAad('refreshToken', 'google', 'g1'),
      ),
    ).toBe('committed');
  });
  it('create encrypts tokens bound to providerId/accountId; reads decrypt them', async () => {
    const { raw, a } = setup();
    const created = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'at', refreshToken: 'rt', idToken: null }),
    });
    const row = raw(created.id);
    expect(FieldCipher.isCiphertext(String(row.accessToken))).toBe(true);
    expect(
      cipher.decrypt(
        String(row.refreshToken),
        accountAad('refreshToken', 'google', 'g1'),
      ),
    ).toBe('rt');
    expect(row.idToken ?? null).toBeNull();
    expect(created).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(
      await a.findOne<Row>({ model: 'account', where: byId(created.id) }),
    ).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(
      (
        await a.findMany<Row>({
          model: 'account',
          where: [{ field: 'userId', value: 'u1' }],
        })
      )[0],
    ).toMatchObject({ accessToken: 'at' });
  });
  it('refresh-token rotation (update with only the token + where id) reads the row identifiers first', async () => {
    const { raw, findOne, update, a } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ refreshToken: 'rt1' }),
    });
    findOne.mockClear();
    update.mockClear();
    await a.update({
      model: 'account',
      where: byId(c.id),
      update: { refreshToken: 'rt2' },
    });
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(findOne.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      cipher.decrypt(
        String(raw(c.id).refreshToken),
        accountAad('refreshToken', 'google', 'g1'),
      ),
    ).toBe('rt2');
  });
  it('a partial update without tokens reads nothing extra', async () => {
    const { findOne, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account() });
    findOne.mockClear();
    await a.update({
      model: 'account',
      where: byId(c.id),
      update: { scope: 'openid' },
    });
    expect(findOne).not.toHaveBeenCalled();
  });
  it('changing providerId/accountId or updating tokens by another where fails loudly', async () => {
    const { a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account() });
    await expect(
      a.update({
        model: 'account',
        where: byId(c.id),
        update: { accountId: 'b' },
      }),
    ).rejects.toThrow(AccountCipherError);
    await expect(
      a.update({
        model: 'account',
        where: [{ field: 'userId', value: 'u1' }],
        update: { accessToken: 'x' },
      }),
    ).rejects.toThrow(AccountCipherError);
  });
  it('ciphertext copied to another row does not decrypt; plaintext in the DB fails loudly', async () => {
    const { raw, a } = setup();
    const one = await a.create<Row>({
      model: 'account',
      data: account({ accountId: 'a1', accessToken: 'secret' }),
    });
    const two = await a.create<Row>({
      model: 'account',
      data: account({ accountId: 'a2' }),
    });
    raw(two.id).accessToken = raw(one.id).accessToken;
    const moved = await a.findOne<Row>({
      model: 'account',
      where: byId(two.id),
    });
    expect(() => moved?.accessToken).toThrow(FieldCipherError);
    raw(two.id).accessToken = 'plain';
    const plain = await a.findOne<Row>({
      model: 'account',
      where: byId(two.id),
    });
    expect(() => plain?.accessToken).toThrow(FieldCipherError);
  });
  it('two consecutive updates never double-encrypt', async () => {
    const { raw, a } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 't1' }),
    });
    const enc = String(raw(c.id).accessToken);
    await a.update({
      model: 'account',
      where: byId(c.id),
      update: { accessToken: enc },
    });
    expect(raw(c.id).accessToken).toBe(enc);
  });
  it('the adapter handed to a transaction callback is wrapped too; other models pass through', async () => {
    const { store, a } = setup();
    await a.transaction(async (trx) => {
      await trx.create({
        model: 'account',
        data: account({ accountId: 'tx', accessToken: 'in-tx' }),
      });
      await trx.create({
        model: 'user',
        data: {
          email: 'e@example.test',
          name: 'plain-name',
          emailVerified: false,
        },
      });
    });
    expect(
      FieldCipher.isCiphertext(
        String(store.account?.find((r) => r.accountId === 'tx')?.accessToken),
      ),
    ).toBe(true);
    expect(store.user?.find((r) => r.email === 'e@example.test')?.name).toBe(
      'plain-name',
    );
  });
  it('forwards the inner schema check registration to the wrapper and its transaction adapter', async () => {
    for (const runtimeEnabled of [true, false]) {
      const inner = memoryAdapter({ account: [] })({});
      const check: SchemaCheck = () => undefined;
      registerSchemaCheck(inner, check, { runtimeEnabled });
      const a = withAccountCipher(inner, cipher);
      expect(schemaCheckFor(a)).toBe(schemaCheckFor(inner));
      expect(runtimeSchemaCheckFor(a)).toBe(runtimeSchemaCheckFor(inner));
      vi.spyOn(inner, 'transaction').mockImplementation((cb) => cb(inner));
      await a.transaction(async (trx) => {
        expect(schemaCheckFor(trx)).toBe(check);
        expect(runtimeSchemaCheckFor(trx)).toBe(
          runtimeEnabled ? check : undefined,
        );
      });
    }
    const unchecked = memoryAdapter({ account: [] })({});
    expect(
      schemaCheckFor(withAccountCipher(unchecked, cipher)),
    ).toBeUndefined();
  });
  it('exposes id, options and createSchema of the inner adapter unchanged', () => {
    const inner = memoryAdapter({ account: [] })({});
    const a = withAccountCipher(inner, cipher);
    expect(a.id).toBe(inner.id);
    expect(a.options).toBe(inner.options);
    expect(a.createSchema).toBe(inner.createSchema);
  });
  it('incrementOne encrypts token sets by id and decrypts the returned row', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'old' }),
    });
    expect(
      await a.incrementOne<Row>({
        model: 'account',
        where: byId(c.id),
        increment: {},
        set: { accessToken: 'bumped', providerId: 'google' },
      }),
    ).toMatchObject({ accessToken: 'bumped' });
    expect(
      cipher.decrypt(
        String(raw(c.id).accessToken),
        accountAad('accessToken', 'google', 'g1'),
      ),
    ).toBe('bumped');
  });
  it('incrementOne fails loud on unsafe token or identity writes before touching the row', async () => {
    const { a, raw } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'keep' }),
    });
    const before = raw(c.id).accessToken;
    const unsafe: Parameters<typeof a.incrementOne>[0][] = [
      {
        model: 'account',
        where: [{ field: 'userId', value: 'u1' }],
        increment: {},
        set: { accessToken: 'x' },
      },
      {
        model: 'account',
        where: byId('missing'),
        increment: {},
        set: { refreshToken: 'x' },
      },
      {
        model: 'account',
        where: byId(c.id),
        increment: {},
        set: { accountId: 'other' },
      },
      { model: 'account', where: byId(c.id), increment: { accessToken: 1 } },
      { model: 'account', where: byId(c.id), increment: { providerId: 1 } },
    ];
    for (const d of unsafe)
      await expect(a.incrementOne(d)).rejects.toThrow(AccountCipherError);
    expect(raw(c.id).accessToken).toBe(before);
    expect(raw(c.id).accountId).toBe('g1');
  });
  it('rejects predicates and ordering on token columns for every account operation', async () => {
    const { a } = setup();
    for (const field of ['accessToken', 'refresh_token', 'idToken']) {
      const where: Where[] = [{ field, value: 'x' }];
      const calls: (() => Promise<unknown>)[] = [
        () => a.findOne({ model: 'account', where }),
        () => a.findMany({ model: 'account', where }),
        () =>
          a.findMany({
            model: 'account',
            sortBy: { field, direction: 'asc' },
          }),
        () => a.count({ model: 'account', where }),
        () => a.update({ model: 'account', where, update: { scope: 's' } }),
        () => a.updateMany({ model: 'account', where, update: { scope: 's' } }),
        () => a.delete({ model: 'account', where }),
        () => a.deleteMany({ model: 'account', where }),
        () => a.consumeOne({ model: 'account', where }),
        () => a.incrementOne({ model: 'account', where, increment: {} }),
      ];
      for (const call of calls)
        await expect(call()).rejects.toThrow(AccountCipherError);
    }
  });
  it('an undecryptable row stays readable without its tokens and can still be deleted', async () => {
    const { a, raw, store } = setup();
    const c = await a.create<Row>({
      model: 'account',
      data: account({ accessToken: 'at', refreshToken: 'rt' }),
    });
    const retired = new FieldCipher(
      { old: randomBytes(32).toString('base64') },
      'old',
    );
    raw(c.id).accessToken = retired.encrypt(
      'at',
      accountAad('accessToken', 'google', 'g1'),
    );
    const [row] = await a.findMany<Row>({
      model: 'account',
      where: byId(c.id),
      limit: 1,
    });
    expect(row?.id).toBe(c.id);
    expect(row?.providerId).toBe('google');
    expect(row?.refreshToken).toBe('rt');
    expect(captureError(() => row?.accessToken)).toMatchObject({
      code: 'UNKNOWN_KID',
    });
    await a.delete({ model: 'account', where: byId(c.id) });
    expect(store.account).toHaveLength(0);
  });
});
