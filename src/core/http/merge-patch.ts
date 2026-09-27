import { apply } from 'tiny-merge-patch';
import { z } from 'zod';
import { AppError, CoreErrors, zodIssuesToFields } from '../errors/index.js';

/**
 * JSON Merge Patch (RFC 7396), ADR 0007 (R30):
 * - `mergePatchSchema(schema)` validate body `application/merge-patch+json`;
 * - `applyMergePatch(schema, current, patch)` merge body đó vào resource hiện tại rồi validate kết quả.
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
 * Kiểu tĩnh của merge patch cho document `T`: mọi member optional; `null` chỉ ở member nullable hoặc
 * optional, và ở mọi entry của `z.record` (xoá entry). Cùng quy tắc với `mergePatchSchema`.
 */
export type MergePatch<T> = {
  [K in keyof T]?: unknown extends T[K]
    ? unknown
    : | PatchValue<NonNullable<T[K]>>
      | (string extends keyof T
          ? null
          : null extends T[K]
            ? null
            : undefined extends T[K]
              ? null
              : never);
};

type Unwrapped = { inner: unknown; optional: boolean; nullable: boolean };

/** Bóc optional/nullable/readonly, ghi lại member có lớp nào. */
function unwrap(t: unknown): Unwrapped {
  let inner = t;
  let optional = false;
  let nullable = false;
  for (;;) {
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
    t instanceof z.ZodDefault ||
    t instanceof z.ZodPrefault ||
    t instanceof z.ZodCatch ||
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

/** Schema patch cho giá trị tại `path` (giá trị member hoặc entry của record). */
function patchValue(t: unknown, path: string): z.ZodType {
  if (
    t instanceof z.ZodDefault ||
    t instanceof z.ZodPrefault ||
    t instanceof z.ZodCatch
  )
    throw buildError(
      path,
      'must not have a default (.default/.prefault/.catch): absent fields mean "unchanged" and invalid ones must be rejected',
    );
  if (t instanceof z.ZodOptional)
    return patchValue(t.unwrap(), path).optional();
  if (t instanceof z.ZodNullable)
    return patchValue(t.unwrap(), path).nullable();
  if (t instanceof z.ZodReadonly) return patchValue(t.unwrap(), path);
  if (t instanceof z.ZodObject) return patchObject(t, `${path}.`);
  if (t instanceof z.ZodRecord) {
    // Entry của record vốn optional nên luôn cho `null` (RFC 7396: xoá entry). Key hữu hạn
    // (enum/literal) làm mọi entry thành bắt buộc: mô hình hoá bằng z.object.
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

function patchObject(o: z.ZodObject, prefix: string): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(o.shape)) {
    const path = `${prefix}${key}`;
    const { optional, nullable } = unwrap(field);
    const value = patchValue(field, path);
    // RFC 7396: null xoá member. Chỉ cho khi document được phép thiếu nó (optional) hoặc giữ null
    // (nullable, applyMergePatch ghi lại null); member bắt buộc và không nullable từ chối null.
    const member = (optional || nullable ? value.nullable() : value).optional();
    // Bất biến "vắng = không đổi" cho cả lớp bọc chưa liệt kê ở trên.
    const absent = z.safeParse(member, undefined);
    if (!absent.success || absent.data !== undefined)
      throw buildError(path, 'must not have a default');
    shape[key] = member;
  }
  return z.strictObject(shape);
}

/**
 * Schema body `application/merge-patch+json`, dựng đệ quy:
 * - mọi member optional ở mọi cấp; key lạ bị từ chối ở mọi cấp (strict);
 * - `null` chỉ ở member nullable hoặc optional trong `schema` (và ở entry của record);
 * - `z.object` lồng → object merge patch lồng; `z.record(z.string(), …)` → patch từng entry;
 *   mảng và scalar → thay nguyên, validate đầy đủ.
 *
 * Ném lỗi lúc dựng (fail loud, không đoán):
 * - `.default()`/`.prefault()`/`.catch()` ở mọi cấp: sẽ điền member client không gửi;
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
  return patchObject(schema, '');
}

/**
 * RFC 7396 §2 `MergePatch(Target, Patch)` qua package `tiny-merge-patch`: thuần, không mutate target.
 * Member tên `__proto__` bị từ chối (422): gán nó sẽ đổi prototype của kết quả thay vì tạo member.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
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
 * Merge patch không biểu diễn được null tường minh (RFC 7396 §1): `null` xoá member. Với member
 * nullable nhưng bắt buộc, "vắng" và "null" là cùng một trạng thái nên member bị xoá được ghi lại `null`.
 */
function restoreNulls(t: unknown, value: unknown): unknown {
  const { inner } = unwrap(t);
  if (!isPlainObject(value)) return value;
  if (inner instanceof z.ZodRecord)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        restoreNulls(inner.valueType, v),
      ]),
    );
  if (!(inner instanceof z.ZodObject)) return value;
  const out: PlainObject = { ...value };
  for (const [key, field] of Object.entries(inner.shape)) {
    const { optional, nullable } = unwrap(field);
    if (!Object.hasOwn(out, key)) {
      if (nullable && !optional) out[key] = null;
    } else out[key] = restoreNulls(field, out[key]);
  }
  return out;
}

/**
 * Áp merge patch đã validate vào resource hiện tại, trả resource mới.
 *
 * - `schema`: document được patch (cùng schema đưa cho `mergePatchSchema`), input ≡ output (không transform).
 * - `current`: resource hiện tại; member ngoài `schema` bị bỏ qua và không có trong kết quả.
 * - Member lồng mà patch không nhắc tới được giữ nguyên. `null` đặt member nullable thành `null` và
 *   xoá member optional (vắng trong kết quả: lưu như một lần xoá, không spread kết quả đè bản ghi cũ).
 * - Kết quả được validate bằng `schema`; sai (vd. patch tạo object lồng mới thiếu member bắt buộc)
 *   → 422 `validation_failed` với path dạng chấm.
 */
export function applyMergePatch<S extends z.ZodObject>(
  schema: S,
  current: z.output<S>,
  patch: MergePatch<z.output<S>>,
): z.output<S> {
  const merged = restoreNulls(schema, mergePatch(current, patch));
  const parsed = schema.safeParse(merged);
  if (!parsed.success)
    throw new AppError(CoreErrors.VALIDATION_FAILED, {
      detail: 'The patch would leave the resource invalid.',
      fields: zodIssuesToFields(parsed.error.issues),
    });
  return parsed.data;
}
