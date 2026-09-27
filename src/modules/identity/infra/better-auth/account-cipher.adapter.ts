import type { DBAdapter, DBTransactionAdapter, Where } from 'better-auth';
import {
  FieldCipher,
  FieldCipherError,
} from '../../../../core/security/index.js';

const ACCOUNT_MODEL = 'account';
export const ACCOUNT_TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'idToken',
] as const;
export type AccountTokenField = (typeof ACCOUNT_TOKEN_FIELDS)[number];
const TOKEN_COLUMN: Record<AccountTokenField, string> = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  idToken: 'id_token',
};
const IDENTITY_FIELDS = ['providerId', 'accountId'] as const;

export class AccountCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountCipherError';
  }
}

/** AAD `auth.account:<cột>:-:<providerId>/<accountId>` (spec §5.9): định danh tự nhiên bất biến, `-` vì không thuộc org. */
export const accountAad = (
  field: AccountTokenField,
  providerId: string,
  accountId: string,
): string => `auth.account:${TOKEN_COLUMN[field]}:-:${providerId}/${accountId}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' ? o[k] : undefined;
const hasToken = (o: Record<string, unknown>): boolean =>
  ACCOUNT_TOKEN_FIELDS.some((f) => f in o);

/** Chỉ nhận `where` đúng một điều kiện `id = <chuỗi>` (A.6: `updateAccount(id, data)`); dạng khác là lỗi to. */
function idOf(where: Where[]): string {
  const [w] = where;
  if (
    where.length !== 1 ||
    !w ||
    w.field !== 'id' ||
    (w.operator !== undefined && w.operator !== 'eq') ||
    w.mode === 'insensitive' ||
    typeof w.value !== 'string'
  )
    throw new AccountCipherError(
      'auth.account token writes must target a single row by id',
    );
  return w.value;
}

function encryptFields(
  cipher: FieldCipher,
  data: Record<string, unknown>,
  providerId: string,
  accountId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ACCOUNT_TOKEN_FIELDS) {
    const v = data[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string')
      throw new AccountCipherError(
        `auth.account.${TOKEN_COLUMN[f]} must be a string or null`,
      );
    const aad = accountAad(f, providerId, accountId);
    if (FieldCipher.isCiphertext(v)) {
      // Validate the row/field binding before persisting an already encrypted value.
      cipher.decrypt(v, aad);
      continue;
    }
    out[f] = cipher.encrypt(v, aad);
  }
  return out;
}

/** Giải mã tại chỗ (dòng mới do adapter trả, không chia sẻ); giá trị không phải bản mã thì ném lỗi, không trả plaintext lẫn lộn. */
function decryptInPlace(cipher: FieldCipher, row: unknown): void {
  if (!isRecord(row) || !hasToken(row)) return;
  const providerId = str(row, 'providerId');
  const accountId = str(row, 'accountId');
  for (const f of ACCOUNT_TOKEN_FIELDS) {
    const v = row[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' || !FieldCipher.isCiphertext(v))
      throw new FieldCipherError(
        `auth.account.${TOKEN_COLUMN[f]} is not encrypted`,
      );
    if (!providerId || !accountId)
      throw new AccountCipherError(
        'reading auth.account tokens requires providerId and accountId in the selection',
      );
    row[f] = cipher.decrypt(v, accountAad(f, providerId, accountId));
  }
}

/** Dòng của model khác có thể mang account qua `join` (S5): giải mã luôn phần đó. */
function decryptResult(cipher: FieldCipher, model: string, row: unknown): void {
  if (model === ACCOUNT_MODEL) return decryptInPlace(cipher, row);
  if (!isRecord(row)) return;
  const joined = row[ACCOUNT_MODEL];
  for (const r of Array.isArray(joined) ? joined : [joined])
    decryptInPlace(cipher, r);
}

/**
 * Tham số của các method generic của `DBAdapter` (review I4). Kiểu tham số không phụ thuộc type parameter
 * (trừ `create`) nên lấy bằng `Parameters<>`; `create` viết tay vì `data: Omit<T, 'id'>`.
 */
type CreateArgs<T> = {
  model: string;
  data: Omit<T, 'id'>;
  select?: string[] | undefined;
  forceAllowId?: boolean | undefined;
};
type FindOneArgs = Parameters<DBTransactionAdapter['findOne']>[0];
type FindManyArgs = Parameters<DBTransactionAdapter['findMany']>[0];
type UpdateArgs = Parameters<DBTransactionAdapter['update']>[0];
type UpdateManyArgs = Parameters<DBTransactionAdapter['updateMany']>[0];
type ConsumeOneArgs = Parameters<DBTransactionAdapter['consumeOne']>[0];

async function prepareUpdate(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
  { where, update }: UpdateArgs,
): Promise<Record<string, unknown>> {
  if (!hasToken(update) && !IDENTITY_FIELDS.some((f) => f in update))
    return update;
  const id = idOf(where);
  const current = await inner.findOne<Record<string, unknown>>({
    model: ACCOUNT_MODEL,
    where: [{ field: 'id', value: id }],
  });
  const providerId = current ? str(current, 'providerId') : undefined;
  const accountId = current ? str(current, 'accountId') : undefined;
  if (!providerId || !accountId)
    throw new AccountCipherError('auth.account row to update was not found');
  if (IDENTITY_FIELDS.some((f) => f in update && update[f] !== current?.[f]))
    throw new AccountCipherError(
      'providerId/accountId of auth.account are immutable',
    );
  return { ...update, ...encryptFields(cipher, update, providerId, accountId) };
}

async function createEncrypted<T extends Record<string, unknown>, R = T>(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
  d: CreateArgs<T>,
): Promise<R> {
  if (d.model !== ACCOUNT_MODEL) return inner.create<T, R>(d);
  const data: Record<string, unknown> = { ...d.data };
  const providerId = str(data, 'providerId');
  const accountId = str(data, 'accountId');
  if (hasToken(data) && (!providerId || !accountId))
    throw new AccountCipherError(
      'auth.account create needs providerId and accountId',
    );
  const encrypted =
    providerId && accountId
      ? encryptFields(cipher, data, providerId, accountId)
      : {};
  const created = await inner.create<T, R>({
    ...d,
    data: { ...d.data, ...encrypted },
  });
  decryptInPlace(cipher, created);
  return created;
}

function wrapWrites(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
): Pick<DBTransactionAdapter, 'create' | 'update' | 'updateMany'> {
  return {
    create: <T extends Record<string, unknown>, R = T>(
      d: CreateArgs<T>,
    ): Promise<R> => createEncrypted<T, R>(inner, cipher, d),
    update: async <T>(d: UpdateArgs): Promise<T | null> => {
      if (d.model !== ACCOUNT_MODEL) return inner.update<T>(d);
      const updated = await inner.update<T>({
        ...d,
        update: await prepareUpdate(inner, cipher, d),
      });
      decryptInPlace(cipher, updated);
      return updated;
    },
    updateMany: async (d: UpdateManyArgs): Promise<number> =>
      d.model !== ACCOUNT_MODEL
        ? inner.updateMany(d)
        : inner.updateMany({
            ...d,
            update: await prepareUpdate(inner, cipher, d),
          }),
  };
}

function wrapOps(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
): DBTransactionAdapter {
  // Keep the library's generic return types without casting caller-selected rows.
  return {
    ...inner,
    ...wrapWrites(inner, cipher),
    findOne: async <T>(d: FindOneArgs): Promise<T | null> => {
      const row = await inner.findOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
    findMany: async <T>(d: FindManyArgs): Promise<T[]> => {
      const rows = await inner.findMany<T>(d);
      for (const r of rows) decryptResult(cipher, d.model, r);
      return rows;
    },
    consumeOne: async <T>(d: ConsumeOneArgs): Promise<T | null> => {
      const row = await inner.consumeOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
  };
}

/**
 * Bọc DBAdapter của Better Auth (spec §5.9, D4): chỉ can thiệp model `account`, bọc cả adapter trong
 * `transaction(cb)`. Không dùng `databaseHooks` vì `account.update.before` không có `where`/id (A.6).
 */
export function withAccountCipher(
  inner: DBAdapter,
  cipher: FieldCipher,
): DBAdapter {
  return {
    ...wrapOps(inner, cipher),
    transaction: <R>(
      cb: (trx: DBTransactionAdapter) => Promise<R>,
    ): Promise<R> => inner.transaction<R>((trx) => cb(wrapOps(trx, cipher))),
  };
}
