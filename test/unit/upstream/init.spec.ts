import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_APP_MODULES_AFTER_INIT,
  cloneAtTag,
  createUpstream,
  initProject,
  releaseUpstream,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

const GIT_CASE_TIMEOUT_MS = 60_000;
const TEAMS = ['--team-core', '@acme/platform', '--team-app', '@acme/app'];
const STARTER = /^(Migration\d{14})_starter_plans\.ts$/;

describe(
  'upstream:init (spec SP7 §6.3.4, S7-D36)',
  { timeout: GIT_CASE_TIMEOUT_MS },
  () => {
    let up: Repo;
    let clone: Repo | undefined;
    beforeEach(() => {
      up = createUpstream();
    }, GIT_CASE_TIMEOUT_MS);
    afterEach(() => {
      removeRepo(clone);
      clone = undefined;
      removeRepo(up);
    });

    it('records the upstream version, copies the seeds, deletes the template zone and rewrites the project seed files', () => {
      clone = initProject(up);
      expect(JSON.parse(clone.read('.upstream/version.json'))).toEqual({
        tag: 'v0.1.0',
        commit: up.git('rev-parse', 'v0.1.0^{commit}'),
      });
      expect(clone.read('src/app.plans.ts')).toBe(
        up.read('src/plans.example.ts'),
      );
      const starters = readdirSync(join(clone.dir, 'src/migrations/app'));
      expect(starters).toHaveLength(1);
      const [file] = starters;
      const m = STARTER.exec(file ?? '');
      expect(m, file).not.toBeNull();
      expect(m?.[1] && m[1] > 'Migration20260101000000').toBe(true);
      const body = clone.read(`src/migrations/app/${file ?? ''}`);
      expect(body).toContain(`class ${basename(file ?? '', '.ts')} `);
      expect(body).not.toContain('Migration20260101000000');
      for (const p of [
        'src/plans.example.ts',
        'src/features/example/example.ts',
        'src/migrations/example/Migration20260101000000_starter_plans.ts',
      ])
        expect(clone.exists(p), p).toBe(false);
      expect(clone.read('src/app.modules.ts')).toBe(
        FIXTURE_APP_MODULES_AFTER_INIT,
      );
      const owners = clone.read('.github/CODEOWNERS');
      expect(owners).toContain('* @acme/app');
      expect(owners).toContain('/src/core/ @acme/platform');
      expect(owners).toContain('/src/features/ @acme/app');
      expect(owners).not.toContain('@TEAM_');
      expect(clone.read('README.md')).toMatch(
        new RegExp(
          `^# ${basename(clone.dir)}\\n\\nDự án clone từ NestJS SaaS Boilerplate v0\\.1\\.0\\.`,
        ),
      );
      expect(clone.tool('check').status).toBe(0);
    });

    it('refuses a clone that is already initialized', () => {
      clone = initProject(up);
      const r = clone.tool('init', [
        '--team-core',
        '@acme/platform',
        '--team-app',
        '@acme/app',
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'upstream:init: .upstream/version.json already exists: this clone is already initialized',
      );
    });

    it('refuses a HEAD that is not a release tag, a dirty tree and malformed teams', () => {
      clone = cloneAtTag(up, 'v0.1.0');
      const run = (args: string[]) => clone?.tool('init', args);
      expect(
        run(['--team-core', 'platform', '--team-app', '@acme/app'])?.stderr,
      ).toContain('--team-core needs a GitHub team or user like @org/team');
      expect(run(['--team-core', '@acme/platform'])?.stderr).toContain(
        'both --team-core and --team-app are required',
      );
      clone.write('scratch.txt', 'x\n');
      expect(
        run(['--team-core', '@acme/platform', '--team-app', '@acme/app'])
          ?.stderr,
      ).toContain('the working tree is not clean');
      clone.commitAll('chore: work after the tag');
      expect(
        run(['--team-core', '@acme/platform', '--team-app', '@acme/app'])
          ?.stderr,
      ).toContain('HEAD is not a release tag');
      expect(clone.exists('.upstream/version.json')).toBe(false);
    });

    it('review M2: moves the cloned upstream release tags to refs/upstream-tags, leaving refs/tags to the project', () => {
      clone = initProject(up);
      expect(clone.git('tag', '--list', 'v*')).toBe('');
      expect(clone.git('rev-parse', 'refs/upstream-tags/v0.1.0')).toBe(
        up.git('rev-parse', 'v0.1.0^{commit}'),
      );
    });

    it('review L1: validates everything before writing; a missing CODEOWNERS template changes nothing', () => {
      releaseUpstream(up, 'v0.1.1', {
        remove: ['docs/upstream/CODEOWNERS.template'],
      });
      clone = cloneAtTag(up, 'v0.1.1');
      const r = clone.tool('init', TEAMS);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        'upstream:init: docs/upstream/CODEOWNERS.template is missing',
      );
      expect(clone.git('status', '--porcelain')).toBe('');
      expect(clone.exists('.upstream/version.json')).toBe(false);
      expect(clone.git('tag', '--list', 'v0.1.1')).toBe('v0.1.1');
    });

    it('review L1: a failure midway rolls the tree back, so a rerun fails the same way instead of refusing', () => {
      // `.github/CODEOWNERS` là thư mục ở bản này: ghi CODEOWNERS hỏng SAU khi vùng template đã bị xoá.
      releaseUpstream(up, 'v0.1.1', {
        write: { '.github/CODEOWNERS/keep.txt': 'x\n' },
      });
      clone = cloneAtTag(up, 'v0.1.1');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const r = clone.tool('init', TEAMS);
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toContain('upstream:init: rolled back');
        expect(r.stderr).not.toContain('already initialized');
        expect(r.stderr).not.toContain('not clean');
        expect(clone.git('status', '--porcelain')).toBe('');
        expect(clone.exists('.upstream/version.json')).toBe(false);
      }
    });
  },
);
