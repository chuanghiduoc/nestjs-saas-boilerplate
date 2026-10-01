import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUpstream,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

const GIT_CASE_TIMEOUT_MS = 60_000;

describe(
  'upstream:check --self (UP-9)',
  { timeout: GIT_CASE_TIMEOUT_MS },
  () => {
    // Chỉ ở repo upstream: một clone (có `.upstream/version.json`) track file vùng dự án ngoài hạt giống là bình thường,
    // và guard của clone chạy ở workflow upstream-guard. Nhờ vậy `pnpm test` của boilerplate xanh ở mọi clone (UP-13).
    it.skipIf(existsSync('.upstream/version.json'))(
      'every file tracked by this repository is zoned, and only seed files are in the project zone',
      () => {
        // `--rev HEAD`: kiểm cây đã commit như CI, không in cảnh báo "uncommitted" khi máy dev đang có thay đổi.
        // Cố ý KHÔNG dùng `gitEnv()`: ca này đọc git của chính repo làm việc (Global Constraints, "Test git hermetic").
        const r = spawnSync(
          process.execPath,
          ['tools/upstream/check.mjs', '--self', '--rev', 'HEAD'],
          { encoding: 'utf8' },
        );
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
      },
    );

    describe('on an upstream fixture', () => {
      let up: Repo;
      // `timeout` của `describe` chỉ áp cho test; hook dựng repo git thật cần cùng biên (mặc định hookTimeout 10 s).
      beforeEach(() => {
        up = createUpstream();
      }, GIT_CASE_TIMEOUT_MS);
      afterEach(() => removeRepo(up));

      it('passes as created', () => {
        expect(up.tool('check', ['--self']).status).toBe(0);
      });
      it('fails on an unzoned file and on project-zone files outside projectSeed', () => {
        up.write('stray.txt', 'x\n');
        up.write('src/app.plans.ts', 'export const appPlans = {};\n');
        up.write(
          'src/migrations/app/Migration20270101000000_x.ts',
          'export {};\n',
        );
        up.commitAll('chore: stray files');
        const r = up.tool('check', ['--self']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(
          'stray.txt: is not classified by .upstream/zones.json',
        );
        expect(r.stderr).toContain(
          'src/app.plans.ts: is in the project zone but not in projectSeed; upstream must not track it',
        );
        expect(r.stderr).toContain(
          'src/migrations/app/Migration20270101000000_x.ts: is in the project zone but not in projectSeed',
        );
      });
    });
  },
);
