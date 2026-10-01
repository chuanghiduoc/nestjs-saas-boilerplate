import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const Zones = z.object({
  boilerplate: z.array(z.string()),
  template: z.array(z.string()),
  project: z.array(z.string()),
});
const weight = (p: string) => (p.endsWith('*') ? p.length - 1 : p.length);
const row = (pattern: string, team: string): [string, string] => [
  pattern,
  team,
];

/**
 * Path vùng dự án mà team nền vẫn sở hữu (review M1, spec SP7 §15): `.github/CODEOWNERS` là lớp chặn cố ý (team dự án sửa
 * được nó thì tự gỡ yêu cầu review của team nền), `.upstream/version.json` chọn bản `check.mjs` mà CI chạy.
 */
const CORE_OWNED_PROJECT_PATHS: readonly string[] = [
  '.github/CODEOWNERS',
  '.upstream/version.json',
];

describe('docs/upstream/CODEOWNERS.template follows .upstream/zones.json', () => {
  it('core team owns boilerplate and template paths (and CODEOWNERS, version.json), app team owns the other project paths, most specific pattern last', () => {
    const zones = Zones.parse(
      JSON.parse(readFileSync('.upstream/zones.json', 'utf8')),
    );
    const rows = [
      ...zones.boilerplate.map((p) => row(p, '@TEAM_CORE')),
      ...zones.template.map((p) => row(p, '@TEAM_CORE')),
      ...zones.project.map((p) =>
        row(
          p,
          CORE_OWNED_PROJECT_PATHS.includes(p) ? '@TEAM_CORE' : '@TEAM_APP',
        ),
      ),
    ].sort(([a], [b]) => weight(a) - weight(b) || (a < b ? -1 : a > b ? 1 : 0));
    const lines = readFileSync('docs/upstream/CODEOWNERS.template', 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines).toEqual([
      '* @TEAM_APP',
      ...rows.map(([p, t]) => `/${p} ${t}`),
    ]);
  });
  it('the core-owned project paths are real project-zone entries (review M1)', () => {
    const zones = Zones.parse(
      JSON.parse(readFileSync('.upstream/zones.json', 'utf8')),
    );
    for (const p of CORE_OWNED_PROJECT_PATHS)
      expect(zones.project, p).toContain(p);
  });
});
