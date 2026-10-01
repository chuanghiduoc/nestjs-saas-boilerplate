import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrationsNotNewerThanZone } from '../../support/migration-zones.js';

const ROOT = 'src/migrations';
const NAME = /^Migration(\d{14})_[a-z0-9_]+\.ts$/;
/** Mọi migration SP3 chạy sau schema Better Auth (FK xuyên schema, spec §6.2 DB-M10). */
const BETTER_AUTH_SCHEMA_TS = '20260927163904';
const MAIN = 'origin/main';
/** Clone vừa khởi tạo (README "Khởi tạo dự án"): `origin` mới còn rỗng nên chưa có `origin/main` trước lần push đầu. */
const UPSTREAM_VERSION_FILE = '.upstream/version.json';
const UpstreamVersion = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});

/** Migration của SP4 chạy sau `…_tenancy_core` (FK tới `organizations`, dòng `permissions`, spec SP4 §7.7). */
const TENANCY_CORE_SUFFIX = '_tenancy_core.ts';

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();
const tsOf = (file: string): string => {
  const m = NAME.exec(basename(file));
  if (!m?.[1])
    throw new Error(
      `${file} does not follow Migration<14 digits>_<snake_name>.ts`,
    );
  return m[1];
};
/**
 * Base để tìm migration "thêm trên nhánh này": merge-base với `origin/main`; nếu chưa có `origin/main` mà repo là clone
 * đã khởi tạo, dùng commit upstream ghi trong `.upstream/version.json` (mọi migration dự án thêm từ lúc init đều được
 * kiểm). Repo upstream (không có file đó) vẫn bắt buộc `origin/main`: không bao giờ skip im lặng.
 */
function baseCommit(): string {
  if (
    spawnSync('git', ['rev-parse', '-q', '--verify', `${MAIN}^{commit}`])
      .status === 0
  )
    return git('merge-base', 'HEAD', MAIN);
  if (existsSync(UPSTREAM_VERSION_FILE))
    return UpstreamVersion.parse(
      JSON.parse(readFileSync(UPSTREAM_VERSION_FILE, 'utf8')),
    ).commit;
  throw new Error(
    `${MAIN} is not available: fetch it (CI checks out with fetch-depth 0)`,
  );
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('migration timestamps (spec SP3 §6.13 "Thứ tự merge")', () => {
  const all = files(ROOT);
  it('are unique across modules, so the runner order is the timestamp order', () => {
    const stamps = all.map(tsOf);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
  it('tenancy migrations run after the Better Auth schema', () => {
    for (const f of all.filter((f) =>
      f.replaceAll('\\', '/').includes('/tenancy/'),
    ))
      expect(tsOf(f) > BETTER_AUTH_SCHEMA_TS, f).toBe(true);
  });
  it(`every migration added on this branch is newer than the newest migration of its zone on ${MAIN} (or the recorded upstream commit) (SP7 S7-D31)`, () => {
    const base = baseCommit();
    const onMain = git('ls-tree', '-r', '--name-only', base, '--', ROOT)
      .split('\n')
      .filter(Boolean);
    const added = [
      ...git(
        'diff',
        '--name-only',
        '--diff-filter=A',
        base,
        'HEAD',
        '--',
        ROOT,
      ).split('\n'),
      ...git('ls-files', '--others', '--exclude-standard', '--', ROOT).split(
        '\n',
      ),
    ].filter((f) => f.endsWith('.ts'));
    expect(migrationsNotNewerThanZone(onMain, added)).toEqual([]);
  });
  it('entitlements and example (template) migrations run after the tenancy core migration; starter plans after entitlements core', () => {
    const tenancyCore = all.find((f) => f.endsWith(TENANCY_CORE_SUFFIX));
    if (!tenancyCore) throw new Error('tenancy_core migration not found');
    const zoned = all.filter((f) => /[\\/](entitlements|example)[\\/]/.test(f));
    for (const f of zoned) expect(tsOf(f) > tsOf(tenancyCore), f).toBe(true);
    const core = all.find((f) => f.endsWith('_entitlements_core.ts'));
    const starter = all.find((f) => f.endsWith('_starter_plans.ts'));
    if (core && starter) expect(tsOf(starter) > tsOf(core)).toBe(true);
  });
});
