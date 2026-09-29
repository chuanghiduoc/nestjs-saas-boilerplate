import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'src/migrations';
const NAME = /^Migration(\d{14})_[a-z0-9_]+\.ts$/;
/** Mọi migration SP3 chạy sau schema Better Auth (FK xuyên schema, spec §6.2 DB-M10). */
const BETTER_AUTH_SCHEMA_TS = '20260927163904';
const MAIN = 'origin/main';

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
  it(`every migration added on this branch is newer than the newest migration on ${MAIN}`, () => {
    let base: string;
    try {
      base = git('merge-base', 'HEAD', MAIN);
    } catch {
      throw new Error(
        `${MAIN} is not available: fetch it (CI checks out with fetch-depth 0)`,
      );
    }
    const onMain = git('ls-tree', '-r', '--name-only', base, '--', ROOT)
      .split('\n')
      .filter(Boolean);
    const newest = onMain.map(tsOf).sort().at(-1) ?? '';
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
    for (const f of added)
      expect(tsOf(f) > newest, `${f} must be newer than ${newest}`).toBe(true);
  });
});
