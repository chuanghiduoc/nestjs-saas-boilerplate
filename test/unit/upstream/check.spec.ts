import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUpstream,
  gitEnv,
  initProject,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

/** Mỗi ca dựng upstream + clone thật bằng git: rộng hơn nhiều so với thực tế. */
const GIT_CASE_TIMEOUT_MS = 60_000;

describe(
  'upstream:check on a clone (spec SP7 §13.2, §13.3)',
  { timeout: GIT_CASE_TIMEOUT_MS },
  () => {
    let up: Repo | undefined;
    let clone: Repo;
    // Hook dựng upstream + clone + init (hàng chục process git/node): cùng biên với test, không phải hookTimeout 10 s.
    // `initProject` tự xoá clone khi hỏng; `up` đã gán nên `afterEach` xoá nó.
    beforeEach(() => {
      up = createUpstream();
      clone = initProject(up);
    }, GIT_CASE_TIMEOUT_MS);
    afterEach(() => {
      removeRepo(clone);
      removeRepo(up);
    });
    const check = () => clone.tool('check');

    it('a freshly initialized clone passes', () => {
      const r = check();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('upstream:check OK (HEAD)');
    });

    it('UP-1: a modified boilerplate file fails, naming the path', () => {
      clone.write('src/core/x.ts', 'export const x = 2;\n');
      clone.commitAll('fix: patch core locally');
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'src/core/x.ts: modified in the boilerplate zone',
      );
    });

    it('UP-2: a deleted boilerplate file fails', () => {
      clone.remove('src/core/x.ts');
      clone.commitAll('chore: drop core file');
      expect(check().stderr).toContain(
        'src/core/x.ts: deleted from the boilerplate zone',
      );
    });

    it('UP-3: the deleted template zone passes; a template file restored with changes or a new template file fails', () => {
      expect(clone.exists('src/features/example/example.ts')).toBe(false);
      clone.write(
        'src/features/example/example.ts',
        'export const example = 2;\n',
      );
      clone.write('src/features/example/new.ts', 'export const n = 1;\n');
      clone.commitAll('feat: edit the sample');
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'src/features/example/example.ts: modified in the template zone (delete it instead)',
      );
      expect(r.stderr).toContain(
        'src/features/example/new.ts: added in the template zone',
      );
    });

    it('UP-4: package.json keeps upstream dependency specs and scripts; project scripts need the app: prefix', () => {
      const pkg = JSON.parse(clone.read('package.json')) as {
        dependencies: Record<string, string>;
        scripts: Record<string, string>;
        version: string;
      };
      pkg.dependencies.zod = '4.7.0';
      pkg.dependencies.dayjs = '1.11.13';
      pkg.scripts.seed = 'node seed.mjs';
      pkg.scripts['app:seed'] = 'node seed.mjs';
      pkg.version = '3.2.1';
      clone.write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      clone.commitAll('chore: deps');
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'package.json: dependencies.zod must stay 4.6.5 (upstream), found 4.7.0',
      );
      expect(r.stderr).toContain(
        'package.json: scripts.seed: project scripts must start with "app:"',
      );
      expect(r.stderr).not.toContain('dayjs');
      expect(r.stderr).not.toContain('app:seed');
      expect(r.stderr).not.toContain('version');
    });

    it('pnpm-workspace.yaml: an upstream line changed fails, a project addition passes', () => {
      clone.write(
        'pnpm-workspace.yaml',
        'minimumReleaseAge: 0\nallowBuilds:\n  esbuild: true\n  sharp: true\n',
      );
      clone.commitAll('chore: workspace');
      const r = check();
      expect(r.stderr).toContain(
        'pnpm-workspace.yaml: upstream line "minimumReleaseAge: 1440" is missing or changed',
      );
      expect(r.stderr).not.toContain('sharp');
    });

    it('UP-5a: loosening zones.json at HEAD does not help (zones are read from the upstream commit)', () => {
      const zones = JSON.parse(clone.read('.upstream/zones.json')) as {
        boilerplate: string[];
        project: string[];
      };
      zones.boilerplate = zones.boilerplate.filter((p) => p !== 'src/core/');
      zones.project.push('src/core/');
      clone.write(
        '.upstream/zones.json',
        `${JSON.stringify(zones, null, 2)}\n`,
      );
      clone.write('src/core/x.ts', 'export const x = 2;\n');
      clone.commitAll('chore: loosen zones');
      const r = check();
      expect(r.stderr).toContain(
        '.upstream/zones.json: modified in the boilerplate zone',
      );
      expect(r.stderr).toContain(
        'src/core/x.ts: modified in the boilerplate zone',
      );
    });

    it('UP-5b: a check.mjs edited at HEAD to always pass still fails, because CI runs the upstream copy', () => {
      clone.write('tools/upstream/check.mjs', 'process.exit(0);\n');
      clone.write('src/core/x.ts', 'export const x = 2;\n');
      clone.commitAll('chore: silence the guard');
      const commit = (
        JSON.parse(clone.read('.upstream/version.json')) as { commit: string }
      ).commit;
      // Đúng lệnh của `.github/workflows/upstream-guard.yml` (bước "clone").
      const script = clone.git('show', `${commit}:tools/upstream/check.mjs`);
      const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
        cwd: clone.dir,
        env: gitEnv(),
        input: script,
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'tools/upstream/check.mjs: modified in the boilerplate zone',
      );
      expect(r.stderr).toContain(
        'src/core/x.ts: modified in the boilerplate zone',
      );
    });

    it('Review Focus 1: reports a modified path with spaces and non-ASCII characters exactly, with the docs/app hint', () => {
      clone.write('docs/superpowers/ghi chú.md', 'project notes\n');
      clone.commitAll('docs: notes');
      expect(check().stderr).toContain(
        'docs/superpowers/ghi chú.md: modified in the boilerplate zone (project documents belong in docs/app/; docs/superpowers/ is upstream history)',
      );
    });

    it.each([
      [
        'invalid JSON',
        '{ "tag": "v0.1.0", ',
        '.upstream/version.json: invalid JSON',
      ],
      [
        'a short commit',
        '{ "tag": "v0.1.0", "commit": "abc1234" }\n',
        'must be a full 40-character lowercase commit SHA',
      ],
      [
        'no tag',
        `{ "commit": "${'a'.repeat(40)}" }\n`,
        '"tag" must look like vX.Y.Z',
      ],
    ])(
      'Review Focus 2: a malformed version.json (%s) fails with one clear line and no stack trace',
      (_name, content, message) => {
        clone.write('.upstream/version.json', content);
        clone.commitAll('chore: hand-edit version');
        const r = check();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(message);
        expect(r.stderr).not.toMatch(/\n\s+at /);
      },
    );

    it('Review Focus 2: a missing version.json points at init / --self', () => {
      clone.remove('.upstream/version.json');
      clone.commitAll('chore: drop version');
      expect(check().stderr).toContain(
        '.upstream/version.json is missing at HEAD',
      );
    });

    it('Review Focus 5: warns that uncommitted changes are not checked', () => {
      clone.write('src/core/x.ts', 'export const x = 3;\n');
      const r = check();
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(
        'upstream:check: warning: uncommitted changes are not checked',
      );
      expect(r.stderr).toContain('src/core/x.ts');
    });

    it('--rev checks another commit than HEAD', () => {
      const good = clone.git('rev-parse', 'HEAD');
      clone.write('src/core/x.ts', 'export const x = 2;\n');
      clone.commitAll('fix: patch core');
      expect(clone.tool('check', ['--rev', good]).status).toBe(0);
      expect(clone.tool('check').status).toBe(1);
    });
  },
);
