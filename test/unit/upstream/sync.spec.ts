import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUpstream,
  initProject,
  releaseUpstream,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

/** Upstream + clone + một hoặc hai lượt sync thật bằng git và node: rộng hơn nhiều so với thực tế. */
const GIT_CASE_TIMEOUT_MS = 120_000;
const STARTER =
  'src/migrations/example/Migration20260101000000_starter_plans.ts';
const V2 = {
  write: {
    'src/core/x.ts': 'export const x = 2;\n',
    'src/features/example/new.ts': 'export const n = 1;\n',
    [STARTER]:
      'export class Migration20260101000000_starter_plans {\n  override name = "Migration20260101000000_starter_plans";\n  readonly v = 2;\n}\n',
    '.env.example': 'A=2\n',
  },
  notes: 'core x is now 2',
};

describe(
  'upstream:sync (spec SP7 §13.4, §8.2)',
  { timeout: GIT_CASE_TIMEOUT_MS },
  () => {
    let up: Repo;
    let clone: Repo;
    // Hook dựng upstream + clone + init + một bản phát hành: cùng biên với test (hookTimeout mặc định chỉ 10 s).
    // `createUpstream`/`initProject` tự xoá thư mục của chúng khi hỏng, nên hook hỏng không rò repo tạm.
    beforeEach(() => {
      up = createUpstream();
      clone = initProject(up);
      releaseUpstream(up, 'v0.2.0', V2);
    }, GIT_CASE_TIMEOUT_MS);
    afterEach(() => {
      removeRepo(clone);
      removeRepo(up);
    });
    const sync = (args: string[], input = '') =>
      clone.tool('sync', args, input);
    const branchFor = (tag: string, from = 'main') =>
      clone.git('switch', '-q', '-c', `chore/upstream-${tag}`, from);
    const recorded = () =>
      JSON.parse(clone.read('.upstream/version.json')) as {
        tag: string;
        commit: string;
      };

    it('UP-7: resolves known conflicts itself, keeps the template deleted, regenerates, records the version and leaves the project version alone', () => {
      const pkg = JSON.parse(clone.read('package.json')) as { version: string };
      pkg.version = '7.0.0';
      clone.write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      clone.commitAll('chore: project version');
      branchFor('v0.2.0');
      const r = sync(['v0.2.0'], 'v0.2.0\n');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('core x is now 2');
      expect(clone.read('src/core/x.ts')).toBe('export const x = 2;\n');
      expect(clone.exists('src/features/example/new.ts')).toBe(false);
      expect(clone.exists(STARTER)).toBe(false);
      expect(clone.read('.env.example')).toBe('REGENERATED=1\n');
      expect(recorded()).toEqual({
        tag: 'v0.2.0',
        commit: up.git('rev-parse', 'v0.2.0^{commit}'),
      });
      expect(
        (JSON.parse(clone.read('package.json')) as { version: string }).version,
      ).toBe('7.0.0');
      clone.git('commit', '-q', '--no-edit');
      expect(clone.tool('check').status).toBe(0);
    });

    it('UP-7: a boilerplate file the project changed by mistake is reset to the upstream version', () => {
      clone.write('src/core/x.ts', 'export const x = 9;\n');
      clone.commitAll('fix: local core patch');
      branchFor('v0.2.0');
      const r = sync(['v0.2.0'], 'v0.2.0\n');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('auto-resolved src/core/x.ts (boilerplate)');
      expect(clone.read('src/core/x.ts')).toBe('export const x = 2;\n');
    });

    it('UP-8: stops at MERGING_MANUAL on a project-zone conflict, then --continue completes; notes of every release in between are shown', () => {
      releaseUpstream(up, 'v0.3.0', {
        write: { 'README.md': '# Boilerplate v3\n' },
        notes: 'readme moved',
      });
      branchFor('v0.3.0');
      const first = sync(['v0.3.0'], 'v0.3.0\n');
      expect(first.status).toBe(3);
      expect(first.stdout).toContain('core x is now 2');
      expect(first.stdout).toContain('readme moved');
      expect(first.stderr).toContain('  README.md (project)');
      clone.git('checkout', '--ours', '--', 'README.md');
      clone.git('add', '--', 'README.md');
      const done = sync(['--continue']);
      expect(done.status, done.stdout + done.stderr).toBe(0);
      expect(recorded().tag).toBe('v0.3.0');
      clone.git('commit', '-q', '--no-edit');
      expect(clone.tool('check').status).toBe(0);
    });

    it('Review Focus 3: refuses a non-newer tag, a tag off upstream/main, the wrong branch and a wrong confirmation, leaving the tree untouched', () => {
      expect(sync(['v0.2.0'], 'v0.2.0\n').stderr).toContain(
        'upstream:sync: run sync on a new branch named chore/upstream-v0.2.0 created from main (current: main)',
      );
      branchFor('v0.2.0');
      expect(sync(['v0.1.0'], 'v0.1.0\n').stderr).toContain(
        'v0.1.0 is not newer than the current v0.1.0',
      );
      up.git('switch', '-q', '-c', 'side', 'v0.1.0');
      up.write('src/core/x.ts', 'export const x = 42;\n');
      up.commitAll('feat: side line');
      up.git('tag', 'v0.9.0');
      up.git('switch', '-q', 'main');
      expect(sync(['v0.9.0'], 'v0.9.0\n').stderr).toContain(
        'v0.9.0 is not on upstream/main',
      );
      expect(sync(['v0.2.0'], 'v0.2.1\n').stderr).toContain(
        'upgrade notes not confirmed; nothing changed',
      );
      expect(sync(['v0.2.0'], '').stderr).toContain(
        'stdin closed before the confirmation was typed',
      );
      expect(sync(['nope']).stderr).toContain(
        '"nope" is not a release tag like vX.Y.Z',
      );
      expect(
        clone.gitRaw('rev-parse', '-q', '--verify', 'MERGE_HEAD').status,
      ).not.toBe(0);
      expect(clone.git('status', '--porcelain')).toBe('');
    });

    it('UP-6: a squash-merged sync PR breaks the ancestry and the guard says so; UP-6b: merge -s ours restores it without changing the tree', () => {
      branchFor('v0.2.0');
      expect(sync(['v0.2.0'], 'v0.2.0\n').status).toBe(0);
      clone.git('commit', '-q', '--no-edit');
      clone.git('switch', '-q', 'main');
      clone.git('merge', '-q', '--squash', 'chore/upstream-v0.2.0');
      clone.git('commit', '-q', '-m', 'chore: sync upstream v0.2.0 (squashed)');
      const squashed = clone.tool('check');
      expect(squashed.status).toBe(1);
      expect(squashed.stderr).toContain(
        'is not in history (squash-merged sync PR?)',
      );
      clone.git('switch', '-q', '-c', 'fix/upstream-ancestry');
      clone.git(
        'merge',
        '-q',
        '-s',
        'ours',
        '--no-ff',
        'v0.2.0',
        '-m',
        'chore: restore the upstream ancestry of v0.2.0',
      );
      expect(clone.git('diff', 'HEAD~1', 'HEAD')).toBe('');
      expect(clone.tool('check').status).toBe(0);
    });

    it('UP-11 (R7-16): two syncs on two branches — the later PR conflicts on version.json and must sync again', () => {
      releaseUpstream(up, 'v0.3.0', {
        write: { 'src/core/x.ts': 'export const x = 3;\n' },
      });
      branchFor('v0.2.0');
      expect(sync(['v0.2.0'], 'v0.2.0\n').status).toBe(0);
      clone.git('commit', '-q', '--no-edit');
      branchFor('v0.3.0');
      expect(sync(['v0.3.0'], 'v0.3.0\n').status).toBe(0);
      clone.git('commit', '-q', '--no-edit');
      clone.git('switch', '-q', 'main');
      clone.git(
        'merge',
        '-q',
        '--no-ff',
        'chore/upstream-v0.2.0',
        '-m',
        'Merge sync v0.2.0',
      );
      const late = clone.gitRaw(
        'merge',
        '--no-ff',
        'chore/upstream-v0.3.0',
        '-m',
        'Merge sync v0.3.0',
      );
      expect(late.status).not.toBe(0);
      expect(clone.git('diff', '--name-only', '--diff-filter=U')).toContain(
        '.upstream/version.json',
      );
      clone.git('merge', '--abort');
      clone.git('switch', '-q', '-C', 'chore/upstream-v0.3.0', 'main');
      const again = sync(['v0.3.0'], 'v0.3.0\n');
      expect(again.status, again.stdout + again.stderr).toBe(0);
      clone.git('commit', '-q', '--no-edit');
      clone.git('switch', '-q', 'main');
      clone.git(
        'merge',
        '-q',
        '--no-ff',
        'chore/upstream-v0.3.0',
        '-m',
        'Merge sync v0.3.0',
      );
      expect(clone.tool('check').status).toBe(0);
      expect(recorded().tag).toBe('v0.3.0');
    });
  },
);
