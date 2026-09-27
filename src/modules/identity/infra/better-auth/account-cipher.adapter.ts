import {
  registerSchemaCheck,
  runtimeSchemaCheckFor,
  schemaCheckFor,
} from '@better-auth/core/db/internal';
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
/** Better Auth resolves a `where`/`sortBy` field by key or by column name (`getDefaultFieldName`), so both are fenced. */
const TOKEN_FIELD_NAMES: readonly string[] = [
  ...ACCOUNT_TOKEN_FIELDS,
  ...Object.values(TOKEN_COLUMN),
];

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
const touchesProtected = (o: Record<string, unknown>): boolean =>
  hasToken(o) || IDENTITY_FIELDS.some((f) => f in o);

/**
 * Bản mã không tất định (IV ngẫu nhiên): so sánh/sắp xếp theo cột token không bao giờ khớp đúng,
 * nên từ chối to thay vì trả kết quả rỗng/sai một cách im lặng (review M2).
 */
function assertNoTokenField(
  where: readonly Where[] | undefined,
  sortField?: string,
): void {
  const fields = (where ?? []).map((w) => w.field);
  if (sortField !== undefined) fields.push(sortField);
  if (fields.some((f) => TOKEN_FIELD_NAMES.includes(f)))
    throw new AccountCipherError(
      'auth.account token columns are encrypted and cannot be filtered or sorted on',
    );
}

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

function decryptToken(
  cipher: FieldCipher,
  f: AccountTokenField,
  v: unknown,
  aad: string,
): string {
  if (typeof v !== 'string' || !FieldCipher.isCiphertext(v))
    throw new FieldCipherError(
      `auth.account.${TOKEN_COLUMN[f]} is not encrypted`,
    );
  return cipher.decrypt(v, aad);
}

/**
 * Giải mã tại chỗ (dòng mới do adapter trả, không chia sẻ). Token không giải mã được (kid đã rút, bản mã hỏng,
 * plaintext trong DB) được thay bằng getter ném đúng `FieldCipherError` đó mỗi lần đọc (review M1): đọc/spread/
 * serialize token vẫn lỗi to, không bao giờ trả plaintext lẫn bản mã, nhưng các cột khác vẫn đọc được. Lý do:
 * `deleteWithHooks` của Better Auth nuốt lỗi của lần `findMany` đọc trước khi xoá và khi đó bỏ qua lệnh xoá —
 * nếu ném ngay lúc đọc thì không xoá được account có token hỏng.
 */
function decryptInPlace(cipher: FieldCipher, row: unknown): void {
  if (!isRecord(row) || !hasToken(row)) return;
  const providerId = str(row, 'providerId');
  const accountId = str(row, 'accountId');
  for (const f of ACCOUNT_TOKEN_FIELDS) {
    const v = row[f];
    if (v === null || v === undefined) continue;
    if (!providerId || !accountId)
      throw new AccountCipherError(
        'reading auth.account tokens requires providerId and accountId in the selection',
      );
    try {
      row[f] = decryptToken(cipher, f, v, accountAad(f, providerId, accountId));
    } catch (err) {
      if (!(err instanceof FieldCipherError)) throw err;
      Object.defineProperty(row, f, {
        enumerable: true,
        configurable: true,
        get: (): never => {
          throw err;
        },
      });
    }
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
type IncrementOneArgs = Parameters<DBTransactionAdapter['incrementOne']>[0];
type WhereArgs = { model: string; where?: Where[] | undefined };

/** Ghi token/định danh: đọc providerId/accountId của đúng một dòng theo id để dựng AAD; thiếu thì lỗi to. */
async function prepareUpdate(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
  where: Where[],
  update: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!touchesProtected(update)) return update;
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

async function incrementEncrypted<T>(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
  d: IncrementOneArgs,
): Promise<T | null> {
  if (touchesProtected(d.increment))
    throw new AccountCipherError(
      'auth.account token and identity fields cannot be incremented',
    );
  const set = d.set && (await prepareUpdate(inner, cipher, d.where, d.set));
  const row = await inner.incrementOne<T>({ ...d, set });
  decryptInPlace(cipher, row);
  return row;
}

function wrapWrites(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
): Pick<
  DBTransactionAdapter,
  'create' | 'update' | 'updateMany' | 'incrementOne'
> {
  return {
    create: <T extends Record<string, unknown>, R = T>(
      d: CreateArgs<T>,
    ): Promise<R> => createEncrypted<T, R>(inner, cipher, d),
    update: async <T>(d: UpdateArgs): Promise<T | null> => {
      if (d.model !== ACCOUNT_MODEL) return inner.update<T>(d);
      assertNoTokenField(d.where);
      const updated = await inner.update<T>({
        ...d,
        update: await prepareUpdate(inner, cipher, d.where, d.update),
      });
      decryptInPlace(cipher, updated);
      return updated;
    },
    updateMany: async (d: UpdateManyArgs): Promise<number> => {
      if (d.model !== ACCOUNT_MODEL) return inner.updateMany(d);
      assertNoTokenField(d.where);
      return inner.updateMany({
        ...d,
        update: await prepareUpdate(inner, cipher, d.where, d.update),
      });
    },
    incrementOne: async <T>(d: IncrementOneArgs): Promise<T | null> => {
      if (d.model !== ACCOUNT_MODEL) return inner.incrementOne<T>(d);
      assertNoTokenField(d.where);
      return incrementEncrypted<T>(inner, cipher, d);
    },
  };
}

/** Kiểm tra `where` của account trước khi chạy một thao tác không ghi token (review M2). */
const guarded =
  <A extends WhereArgs, R>(run: (d: A) => Promise<R>) =>
  async (d: A): Promise<R> => {
    if (d.model === ACCOUNT_MODEL) assertNoTokenField(d.where);
    return run(d);
  };

/**
 * Liệt kê tường minh mọi thành viên của `DBTransactionAdapter` 1.7.6 (không spread `inner`): một method mới
 * của bản nâng cấp sau là lỗi biên dịch, không lọt qua như một đường ghi/đọc token chưa được bọc (review I2).
 */
function wrapOps(
  inner: DBTransactionAdapter,
  cipher: FieldCipher,
): DBTransactionAdapter {
  const wrapped: DBTransactionAdapter = {
    id: inner.id,
    options: inner.options,
    createSchema: inner.createSchema,
    ...wrapWrites(inner, cipher),
    findOne: async <T>(d: FindOneArgs): Promise<T | null> => {
      if (d.model === ACCOUNT_MODEL) assertNoTokenField(d.where);
      const row = await inner.findOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
    findMany: async <T>(d: FindManyArgs): Promise<T[]> => {
      if (d.model === ACCOUNT_MODEL)
        assertNoTokenField(d.where, d.sortBy?.field);
      const rows = await inner.findMany<T>(d);
      for (const r of rows) decryptResult(cipher, d.model, r);
      return rows;
    },
    consumeOne: async <T>(d: ConsumeOneArgs): Promise<T | null> => {
      if (d.model === ACCOUNT_MODEL) assertNoTokenField(d.where);
      const row = await inner.consumeOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
    count: guarded((d) => inner.count(d)),
    delete: guarded((d) => inner.delete(d)),
    deleteMany: guarded((d) => inner.deleteMany(d)),
  };
  forwardSchemaCheck(inner, wrapped);
  return wrapped;
}

/**
 * `kyselyAdapter` đăng ký schema check vào WeakMap theo đúng instance adapter
 * (`@better-auth/kysely-adapter` `registerSchemaCheck(instance, …)`), và Better Auth tra lại bằng
 * `runtimeSchemaCheckFor(ctx.adapter)`/`schemaCheckFor(ctx.adapter)` (`context/create-context.mjs`,
 * `context/transaction.mjs`). Wrapper là object mới nên phải đăng ký lại cùng check và cùng cờ runtime,
 * nếu không `validateSchema` (spec §5.4) bị tắt im lặng (review I1).
 */
function forwardSchemaCheck(from: object, to: object): void {
  const check = schemaCheckFor(from);
  if (!check) return;
  registerSchemaCheck(to, check, {
    runtimeEnabled: runtimeSchemaCheckFor(from) !== undefined,
  });
}

/**
 * Bọc DBAdapter của Better Auth (spec §5.9, D4): chỉ can thiệp model `account`, bọc cả adapter trong
 * `transaction(cb)`. Không dùng `databaseHooks` vì `account.update.before` không có `where`/id (A.6).
 */
export function withAccountCipher(
  inner: DBAdapter,
  cipher: FieldCipher,
): DBAdapter {
  const wrapped: DBAdapter = {
    ...wrapOps(inner, cipher),
    transaction: <R>(
      cb: (trx: DBTransactionAdapter) => Promise<R>,
    ): Promise<R> => inner.transaction<R>((trx) => cb(wrapOps(trx, cipher))),
  };
  forwardSchemaCheck(inner, wrapped);
  return wrapped;
}
