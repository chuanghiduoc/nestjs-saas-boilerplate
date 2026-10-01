import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const Config = z.object({
  'release-type': z.literal('simple'),
  'include-component-in-tag': z.literal(false),
  'include-v-in-tag': z.literal(true),
  'changelog-sections': z.array(
    z.object({ type: z.string(), section: z.string() }),
  ),
  packages: z.object({ '.': z.object({}).passthrough() }),
});
const read = (p: string) => readFileSync(p, 'utf8');

describe('release-please configuration (spec SP7 S7-D10, §13.6)', () => {
  const config = Config.parse(JSON.parse(read('release-please-config.json')));
  const manifest = z
    .object({ '.': z.string() })
    .parse(JSON.parse(read('.release-please-manifest.json')));

  it('releases with the simple strategy and never touches package.json (project-owned version)', () => {
    // Đọc văn bản thô: zod bỏ khoá lạ khi parse, nên một `extra-files` trỏ package.json sẽ không hiện trong `config`.
    expect(read('release-please-config.json')).not.toContain('package.json');
    expect(config['changelog-sections'].map((s) => s.type)).toEqual([
      'feat',
      'fix',
      'perf',
      'refactor',
      'docs',
    ]);
  });
  it('version.txt, the manifest and the newest CHANGELOG entry agree', () => {
    const version = read('version.txt').trim();
    expect(manifest['.']).toBe(version);
    expect(/^## \[?(\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md'))?.[1]).toBe(
      version,
    );
  });
  it('the release files and the PR template are in the boilerplate zone (R-X22)', () => {
    const zones = z
      .object({ boilerplate: z.array(z.string()) })
      .parse(JSON.parse(read('.upstream/zones.json')));
    for (const f of [
      'CHANGELOG.md',
      'version.txt',
      'release-please-config.json',
      '.release-please-manifest.json',
      '.github/pull_request_template.md',
    ])
      expect(zones.boilerplate, f).toContain(f);
  });
  it('the PR template has the "## Upgrade notes" section that release PRs copy into CHANGELOG.md (spec §13.6)', () => {
    expect(read('.github/pull_request_template.md')).toMatch(
      /^## Upgrade notes$/m,
    );
  });
});
