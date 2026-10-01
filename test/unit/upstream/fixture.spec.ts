import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloneAtTag,
  createUpstream,
  gitEnv,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

const GIT_CASE_TIMEOUT_MS = 60_000;
const ALLOWED_CONFIG_ORIGIN = /^(file:\.git\/config|command line:)\t/;

describe(
  'the upstream fixture is hermetic (spec SP7 §13, review C3)',
  { timeout: GIT_CASE_TIMEOUT_MS },
  () => {
    let up: Repo | undefined;
    let clone: Repo | undefined;
    afterEach(() => {
      removeRepo(clone);
      removeRepo(up);
      clone = undefined;
      up = undefined;
      vi.unstubAllEnvs();
    });

    it('a clone right after cloneAtTag has a clean tree and byte-identical LF files', () => {
      up = createUpstream();
      clone = cloneAtTag(up, 'v0.1.0');
      expect(clone.git('status', '--porcelain')).toBe('');
      expect(clone.read('src/core/x.ts')).toBe('export const x = 1;\n');
      expect(clone.read('.env.example')).toBe('A=1\n');
    });

    it('ignores the caller git environment and system/global config', () => {
      // Như khi `pnpm test` chạy trong một hook git của repo thật.
      vi.stubEnv('GIT_DIR', join(tmpdir(), 'nsb-not-a-repo', '.git'));
      vi.stubEnv('GIT_INDEX_FILE', join(tmpdir(), 'nsb-not-an-index'));
      expect(
        Object.keys(gitEnv()).filter(
          (k) => k === 'GIT_DIR' || k === 'GIT_INDEX_FILE',
        ),
      ).toEqual([]);
      up = createUpstream();
      expect(up.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      const origins = up.git('config', '--list', '--show-origin').split('\n');
      expect(origins.filter((l) => !ALLOWED_CONFIG_ORIGIN.test(l))).toEqual([]);
      expect(up.git('log', '-1', '--format=%an <%ae>')).toBe(
        'Fixture <fixture@example.test>',
      );
    });
  },
);
