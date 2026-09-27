import { apply } from 'tiny-merge-patch';
import { z } from 'zod';
import { AppError, CoreErrors, zodIssuesToFields } from '../errors/index.js';

/**
 * JSON Merge Patch (RFC 7396), ADR 0007 (R30, R35):
 * - `mergePatchSchema(schema)` validate body `application/merge-patch+json`;
 * - `applyMergePatch(target, patch)` thuật toán RFC 7396 §2 thuần, không biết schema;
 * - `mergePatchInto(schema, current, patch)` bước theo schema cho route PATCH: RFC → ghi lại `null`
 *   cho member nullable bắt buộc → validate kết quả.
 */

type PlainObject = Record<string, unknown>;

const isPlainObject = (v: unknown): v is PlainObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Giá trị patch của một member: object thì patch đệ quy; mảng và scalar thay nguyên. */
type PatchValue<V> = V extends readonly unknown[]
  ? V
  : V extends PlainObject
    ? MergePatch<V>
    : V;

/**
 * Kiểu tĩnh của merge patch cho document `T`: mọi member optional; `null` chỉ ở member nullable
 * (spec SP1, R35), và ở mọi entry của `z.record` (xoá entry). Cùng quy tắc với `mergePatchSchema`.
 */
export type MergePatch<T> = {
  [K in keyof T]?: unknown extends T[K]
    ? unknown
    : | PatchValue<NonNullable<T[K]>>
      | (string extends keyof T ? null : null extends T[K] ? null : never);
};

type Unwrapped = { inner: unknown; optional: boolean; nullable: boolean };

/**
 * Bóc optional/nullable/readonly, ghi lại member có lớp nào. `z.union([X, z.null()])` được coi y hệt
 * `X.nullable()`; union còn nhiều nhánh khác null thì dừng ở chính union đó, vẫn đánh dấu nullable
 * nếu có nhánh `z.null()` và optional nếu có nhánh optional/`z.undefined()`.
 */
function unwrap(t: unknown): Unwrapped {
  let inner = t;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (inner instanceof z.ZodUnion) {
      const rest = inner.options.filter((o) => !(o instanceof z.ZodNull));
      if (rest.length < inner.options.length) nullable = true;
      if (rest.some((o) => o instanceof z.ZodUndefined || unwrap(o).optional))
        optional = true;
      if (rest.length !== 1 || rest.length === inner.options.length)
        return { inner, optional, nullable };
      inner = rest[0];
      continue;
    }
    if (inner instanceof z.ZodOptional) optional = true;
    else if (inner instanceof z.ZodNullable) nullable = true;
    else if (!(inner instanceof z.ZodReadonly))
      return { inner, optional, nullable };
    inner = inner.unwrap();
  }
}

/** Schema nhận một JSON object ở đâu đó, nhìn xuyên qua mọi lớp bọc. */
function acceptsJsonObject(t: unknown): boolean {
  if (t instanceof z.ZodObject || t instanceof z.ZodRecord) return true;
  if (
    t instanceof z.ZodLazy ||
    t instanceof z.ZodOptional ||
    t instanceof z.ZodNullable ||
    t instanceof z.ZodReadonly
  )
    return acceptsJsonObject(t.unwrap());
  if (t instanceof z.ZodPipe)
    return acceptsJsonObject(t.in) || acceptsJsonObject(t.out);
  if (t instanceof z.ZodUnion) return t.options.some(acceptsJsonObject);
  if (t instanceof z.ZodIntersection)
    return acceptsJsonObject(t.def.left) || acceptsJsonObject(t.def.right);
  return false;
}

const buildError = (path: string, reason: string) =>
  new Error(`mergePatchSchema: field "${path}" ${reason} (see ADR 0007)`);

const child = (path: string, key: string) => (path ? `${path}.${key}` : key);

/**
 * Kiểu schema mà schema con nằm ở **cùng path** (lớp bọc, nhánh, hai đầu pipe). Mọi container khác
 * (mảng, record, map, set, tuple, function, template literal, catchall) đặt schema con ở `path.*`.
 */
const SAME_PATH_TYPES: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'readonly',
  'nonoptional',
  'success',
  'promise',
  'lazy',
  'pipe',
  'union',
  'intersection',
]);

/** Mọi schema zod nằm trong một giá trị của `def` (trực tiếp hoặc trong mảng, vd. `options`, `items`). */
function schemasIn(value: unknown): unknown[] {
  if (value instanceof z.ZodType) return [value];
  if (Array.isArray(value)) return value.flatMap(schemasIn);
  return [];
}

/**
 * Path đầu tiên có `.default()`/`.prefault()`/`.catch()` ở bất kỳ đâu trong `t`.
 *
 * Không liệt kê từng container: duyệt **mọi schema con có trong `def`** (public API của zod classic),
 * nên wrapper, union, intersection, pipe/codec, tuple (items + rest), mảng, record (key + value),
 * map, set, promise, function (input + output), template literal và object `catchall` đều được phủ,
 * kể cả container zod thêm sau này. Chỉ hai chỗ cần xử lý riêng: `shape` của object (object thường,
 * không phải schema, và cho path theo tên key) và `lazy` (schema con nằm sau getter).
 * `seen` chặn vòng lặp của lazy đệ quy.
 */
function findFiller(
  t: unknown,
  path: string,
  seen: Set<unknown>,
): string | undefined {
  if (!(t instanceof z.ZodType) || seen.has(t)) return undefined;
  seen.add(t);
  if (
    t instanceof z.ZodDefault ||
    t instanceof z.ZodPrefault ||
    t instanceof z.ZodCatch
  )
    return path;
  const walk = (children: readonly unknown[], at: string) => {
    for (const c of children) {
      const found = findFiller(c, at, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  if (t instanceof z.ZodLazy) return walk([t.unwrap()], path);
  if (t instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(t.shape)) {
      const found = findFiller(field, child(path, key), seen);
      if (found !== undefined) return found;
    }
  }
  const defValues: unknown[] = Object.values(t.def);
  return walk(
    defValues.flatMap(schemasIn),
    SAME_PATH_TYPES.has(t.def.type) ? path : `${path}.*`,
  );
}

/** Schema patch cho giá trị tại `path` (giá trị member hoặc entry của record). */
function patchValue(t: unknown, path: string): z.ZodType {
  if (t instanceof z.ZodOptional)
    return patchValue(t.unwrap(), path).optional();
  if (t instanceof z.ZodNullable)
    return patchValue(t.unwrap(), path).nullable();
  if (t instanceof z.ZodReadonly) return patchValue(t.unwrap(), path);
  if (t instanceof z.ZodUnion) {
    // `z.union([X, z.null()])` ≡ `X.nullable()` (R35).
    const rest = t.options.filter((o) => !(o instanceof z.ZodNull));
    if (rest.length === 1 && rest.length < t.options.length)
      return patchValue(rest[0], path).nullable();
  }
  if (t instanceof z.ZodObject) return patchObject(t, path);
  if (t instanceof z.ZodRecord) {
    // Entry của record không phải field của schema mà là khoá của map: luôn cho `null` để xoá entry
    // (RFC 7396). Key hữu hạn (enum/literal) làm mọi entry thành bắt buộc: mô hình hoá bằng z.object.
    if (!(t.keyType instanceof z.ZodString))
      throw buildError(
        path,
        `is a record keyed by "${t.keyType._zod.def.type}"; merge patch supports z.string() record keys only (use z.object for a fixed key set)`,
      );
    return z.record(t.keyType, patchValue(t.valueType, `${path}.*`).nullable());
  }
  if (!(t instanceof z.ZodType))
    throw buildError(path, 'is not a zod (classic) schema');
  if (acceptsJsonObject(t))
    throw buildError(
      path,
      `accepts a JSON object through a ${t.def.type} schema, so the shape to merge into is ambiguous; use a plain z.object/z.record, or give it its own endpoint`,
    );
  // Scalar, enum, mảng (RFC 7396 thay nguyên) và JSON tự do z.unknown()/z.any().
  return t;
}

function patchObject(o: z.ZodObject, path: string): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(o.shape)) {
    const at = child(path, key);
    // `null` chỉ hợp lệ khi schema gốc nullable (patchValue giữ nguyên lớp nullable); optional mà
    // không nullable thì từ chối `null`. Muốn xoá được thì khai báo nullable (spec SP1, R35).
    const member = patchValue(field, at).optional();
    // Bất biến "vắng = không đổi" cho cả lớp bọc chưa liệt kê trong findFiller.
    const absent = z.safeParse(member, undefined);
    if (!absent.success || absent.data !== undefined)
      throw buildError(at, 'must not have a default');
    shape[key] = member;
  }
  return z.strictObject(shape);
}

/**
 * Schema body `application/merge-patch+json`, dựng đệ quy:
 * - mọi member optional ở mọi cấp; key lạ bị từ chối ở mọi cấp (strict);
 * - `null` chỉ ở member nullable trong `schema` (`.nullable()`, `.nullish()`, `z.union([X, z.null()])`)
 *   và ở entry của record; member optional nhưng không nullable từ chối `null`;
 * - `z.object` lồng → object merge patch lồng; `z.record(z.string(), …)` → patch từng entry;
 *   mảng và scalar → thay nguyên, validate đầy đủ.
 *
 * Ném lỗi lúc dựng (fail loud, không đoán):
 * - `.default()`/`.prefault()`/`.catch()` ở bất kỳ đâu trong field (kể cả trong union, pipe, mảng):
 *   sẽ điền member client không gửi hoặc thay giá trị sai bằng giá trị khác trong im lặng;
 * - member nhận object qua union, intersection, pipe hoặc lazy (không rõ hình dạng để merge), và
 *   record có key không phải string.
 *
 * Kiểu trả về khai báo bằng overload: shape dựng lúc runtime nên TypeScript không tự suy ra được.
 * `MergePatch` mô tả đúng các quy tắc trên và được khoá bằng type test (`merge-patch.spec.ts`).
 */
export function mergePatchSchema<S extends z.ZodObject>(
  schema: S,
): z.ZodType<MergePatch<z.output<S>>, MergePatch<z.input<S>>>;
export function mergePatchSchema(schema: z.ZodObject): z.ZodType {
  const filled = findFiller(schema, '', new Set());
  if (filled !== undefined)
    throw buildError(
      filled,
      'must not have a default (.default/.prefault/.catch): absent fields mean "unchanged" and invalid values must be rejected, not replaced',
    );
  return patchObject(schema, '');
}

/**
 * RFC 7396 §2 `MergePatch(Target, Patch)` thuần qua package `tiny-merge-patch`: không biết schema,
 * không mutate `target`/`patch`, `null` luôn xoá member. Member tên `__proto__` bị từ chối (422):
 * gán nó sẽ đổi prototype của kết quả thay vì tạo member, dữ liệu mất trong im lặng.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  assertNoProtoMember(patch, []);
  return apply(target, patch);
}

function assertNoProtoMember(value: unknown, path: string[]): void {
  if (!isPlainObject(value)) return;
  for (const [key, member] of Object.entries(value)) {
    const at = [...path, key];
    if (key === '__proto__')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'One or more fields did not pass validation.',
        fields: [
          {
            path: at.join('.'),
            code: 'invalid',
            message: '"__proto__" is not an allowed member name',
          },
        ],
      });
    assertNoProtoMember(member, at);
  }
}

/**
 * Ghi lại `null` cho member nullable bắt buộc mà **patch gửi `null`** (xem `mergePatchInto`). Duyệt
 * theo patch, không theo kết quả: key patch không nhắc tới không bao giờ được thêm vào.
 */
function restoreNulls(t: unknown, merged: unknown, patch: unknown): unknown {
  const { inner } = unwrap(t);
  if (!isPlainObject(merged) || !isPlainObject(patch)) return merged;
  const fields: Record<string, unknown> =
    inner instanceof z.ZodObject
      ? inner.shape
      : inner instanceof z.ZodRecord
        ? Object.fromEntries(
            Object.keys(patch).map((k) => [k, inner.valueType]),
          )
        : {};
  const out: PlainObject = { ...merged };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (!Object.hasOwn(fields, key)) continue;
    const field = fields[key];
    if (patchValue === null) {
      const { optional, nullable } = unwrap(field);
      if (nullable && !optional && inner instanceof z.ZodObject)
        out[key] = null;
    } else if (Object.hasOwn(out, key))
      out[key] = restoreNulls(field, out[key], patchValue);
  }
  return out;
}

/**
 * Bước theo schema cho route PATCH: áp patch (đã qua `mergePatchSchema`) vào resource hiện tại.
 *
 * Vì sao tách khỏi `applyMergePatch`: theo RFC 7396 `null` **xoá** member (§1: merge patch không biểu
 * diễn được null tường minh), còn ở domain `{"nickname": null}` nghĩa là **đặt về null**. Với member
 * nullable bắt buộc, kết quả RFC thiếu key nên sai schema; hàm này ghi lại `null` cho đúng ý domain.
 *
 * 1. `applyMergePatch(current, patch)` (RFC thuần); member lồng patch không nhắc tới được giữ nguyên.
 * 2. Member nullable và bắt buộc mà patch gửi `null` → ghi lại `null`; key patch không nhắc tới
 *    không bao giờ được thêm. Member nullish (`.nullish()`) bị xoá → vắng
 *    trong kết quả: lưu như một lần xoá, không spread kết quả đè bản ghi cũ.
 * 3. Validate bằng `schema` (input ≡ output, không transform); sai (vd. tạo object lồng mới thiếu
 *    member bắt buộc) → 422 `validation_failed` với path dạng chấm. Member ngoài `schema` bị bỏ.
 */
export function mergePatchInto<S extends z.ZodObject>(
  schema: S,
  current: z.output<S>,
  patch: MergePatch<z.output<S>>,
): z.output<S> {
  const merged = restoreNulls(schema, applyMergePatch(current, patch), patch);
  const parsed = schema.safeParse(merged);
  if (!parsed.success)
    throw new AppError(CoreErrors.VALIDATION_FAILED, {
      detail: 'The patch would leave the resource invalid.',
      fields: zodIssuesToFields(parsed.error.issues),
    });
  return parsed.data;
}
