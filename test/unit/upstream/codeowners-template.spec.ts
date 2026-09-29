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

describe('docs/upstream/CODEOWNERS.template follows .upstream/zones.json', () => {
  it('core team owns boilerplate and template paths, app team owns project paths, most specific pattern last', () => {
    const zones = Zones.parse(
      JSON.parse(readFileSync('.upstream/zones.json', 'utf8')),
    );
    const rows = [
      ...zones.boilerplate.map((p) => row(p, '@TEAM_CORE')),
      ...zones.template.map((p) => row(p, '@TEAM_CORE')),
      ...zones.project.map((p) => row(p, '@TEAM_APP')),
    ].sort(([a], [b]) => weight(a) - weight(b) || (a < b ? -1 : a > b ? 1 : 0));
    const lines = readFileSync('docs/upstream/CODEOWNERS.template', 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines).toEqual([
      '* @TEAM_APP',
      ...rows.map(([p, t]) => `/${p} ${t}`),
    ]);
  });
});
