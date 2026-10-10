import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Fallback của S6-A36 (spike W2: oasdiff v1.32.1 xếp việc bỏ trường payload của webhook là WARN, thoát 0): webhook đã có
 * trên `origin/main` phải giữ nguyên schema; thêm webhook mới được; đổi payload phải lên version (khoá `<type>@<version+1>`).
 * So `openapi.json` đã commit. Base như `migration-order.spec.ts`: `origin/main`, hoặc commit upstream của clone đã khởi tạo;
 * không có cả hai thì ném, không bao giờ skip im lặng.
 */
const MAIN = 'origin/main';
const UPSTREAM_VERSION_FILE = '.upstream/version.json';
const UpstreamVersion = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});
const Doc = z.object({
  webhooks: z.record(z.string(), z.unknown()).optional(),
});
type Webhooks = Record<string, unknown>;

const hasCommit = (ref: string) =>
  spawnSync('git', ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
    .status === 0;
function baseRef(): string {
  if (hasCommit(MAIN)) return MAIN;
  if (existsSync(UPSTREAM_VERSION_FILE))
    return UpstreamVersion.parse(
      JSON.parse(readFileSync(UPSTREAM_VERSION_FILE, 'utf8')),
    ).commit;
  throw new Error(
    `${MAIN} is not available: fetch it (CI checks out with fetch-depth 0)`,
  );
}
/** Base chưa có `openapi.json` (lịch sử trước SP1) → không có webhook nào đã công bố. */
function baseWebhooks(ref: string): Webhooks {
  if (spawnSync('git', ['cat-file', '-e', `${ref}:openapi.json`]).status !== 0)
    return {};
  return (
    Doc.parse(
      JSON.parse(
        execFileSync('git', ['show', `${ref}:openapi.json`], {
          encoding: 'utf8',
        }),
      ),
    ).webhooks ?? {}
  );
}
/** Khoá đã công bố mà schema đổi hoặc biến mất. */
const brokenWebhooks = (base: Webhooks, rev: Webhooks): string[] =>
  Object.keys(base).filter(
    (k) => JSON.stringify(base[k]) !== JSON.stringify(rev[k]),
  );

describe('published webhook payloads never change in place (S6-A36 fallback)', () => {
  const current =
    Doc.parse(JSON.parse(readFileSync('openapi.json', 'utf8'))).webhooks ?? {};

  it('m-3: no published webhook schema uses $ref (the comparison is per entry, so a shared component would change unseen)', () => {
    // Chọn "cấm $ref" thay cho "giải $ref rồi so": webhookDocs hôm nay sinh schema nội tuyến; nếu một ngày zod sinh $defs
    // (schema đệ quy, `.meta({ id })`), ca này đỏ to và người sửa phải giải $ref trong brokenWebhooks trước khi merge.
    const refs = Object.entries(current)
      .filter(([, v]) => JSON.stringify(v).includes('"$ref"'))
      .map(([k]) => k);
    expect(refs).toEqual([]);
  });
  it('every webhook of the base is still present with the same schema', () => {
    expect(brokenWebhooks(baseWebhooks(baseRef()), current)).toEqual([]);
  });
  it('the comparison catches a removed payload field and a removed webhook, and allows a new one (not vacuous)', () => {
    const key = 'tenancy.org.updated@1';
    expect(Object.keys(current)).toContain(key);
    // Bản sao sâu, đổi đúng schema của body (mọi khoá khác giữ nguyên thứ tự): như một payload bị bỏ trường.
    const item: unknown = structuredClone(current[key]);
    const path = ['post', 'requestBody', 'content', 'application/json'];
    const json = path.reduce<unknown>(
      (o, k) =>
        typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined,
      item,
    );
    if (typeof json !== 'object' || json === null)
      throw new Error(`${key} has no application/json body`);
    expect(brokenWebhooks(current, { ...current, [key]: item })).toEqual([]);
    Reflect.set(json, 'schema', { type: 'object' });
    expect(brokenWebhooks(current, { ...current, [key]: item })).toEqual([key]);
    const { [key]: _removed, ...withoutIt } = current;
    expect(brokenWebhooks(current, withoutIt)).toEqual([key]);
    expect(
      brokenWebhooks(current, { ...current, 'tenancy.org.updated@2': {} }),
    ).toEqual([]);
  });
});
