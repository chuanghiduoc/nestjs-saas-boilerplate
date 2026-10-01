import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * File thật của repo được chép vào upstream fixture: bộ công cụ, vùng và `.gitattributes` đúng như sẽ ship.
 * `zones.mjs` bắt buộc: `init.mjs` và `sync.mjs` import nó (thiếu → `ERR_MODULE_NOT_FOUND` ở mọi clone của test).
 * `.gitattributes` (`* text=auto eol=lf`, như repo thật): file của fixture giữ LF ở mọi máy, cả khi git của người chạy
 * cấu hình khác.
 */
const COPIED_FROM_REPO = [
  '.gitattributes',
  '.upstream/zones.json',
  'tools/upstream/check.mjs',
  'tools/upstream/zones.mjs',
  'tools/upstream/sync.mjs',
  'tools/upstream/init.mjs',
  'docs/upstream/CODEOWNERS.template',
] as const;
const REPO_ROOT = process.cwd();
const RM_RETRIES = 5;
const FIXTURE_AUTHOR = { name: 'Fixture', email: 'fixture@example.test' };
/** Git for Windows ánh xạ `/dev/null` sang `nul` (đã chạy thử trên Git 2.55 Windows lúc viết plan). */
const NO_GIT_CONFIG_FILE = '/dev/null';

/**
 * Env hermetic cho mọi process git (và công cụ `tools/upstream/*.mjs`, vốn gọi git) của test repo tạm (C3 của review):
 * - bỏ mọi `GIT_*` kế thừa (`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` khi `pnpm test` chạy trong hook git sẽ làm lệnh
 *   "trong repo tạm" đánh vào repo thật; `GIT_CONFIG_PARAMETERS`…);
 * - không đọc config hệ thống/global (`core.autocrlf=true` của Git for Windows biến LF thành CRLF khi clone; hook global,
 *   `init.templateDir`, `tag.gpgSign`, `merge.*`, `rerere.enabled`, `core.quotePath`…);
 * - không bao giờ hỏi mật khẩu; tác giả/người commit cố định (thay cho `git config user.*`).
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NO_GIT_CONFIG_FILE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
  };
}

/** `git` ngoài một `Repo` (init, clone): cùng env hermetic, stderr không rò ra console của Vitest. */
const gitAt = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** `src/app.modules.ts` của upstream fixture: dòng template theo quy ước `// upstream:template` (Task 3). */
export const FIXTURE_APP_MODULES = [
  "import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';",
  "import { ExampleModule } from './features/example/index.js'; // upstream:template",
  "import { examplePlans } from './plans.example.js';",
  '',
  'const features: AppFeatures = { api: [], worker: [] };',
  'features.api.push(ExampleModule.forApi()); // upstream:template',
  'features.worker.push(ExampleModule.forWorker()); // upstream:template',
  '',
  'export const APP_MODULES = await composeAppModules({ disable: [], plans: examplePlans, features });',
  '',
].join('\n');
export const FIXTURE_APP_MODULES_AFTER_INIT = [
  "import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';",
  "import { examplePlans } from './app.plans.js';",
  '',
  'const features: AppFeatures = { api: [], worker: [] };',
  '',
  'export const APP_MODULES = await composeAppModules({ disable: [], plans: examplePlans, features });',
  '',
].join('\n');

const FIXTURE_FILES: Record<string, string> = {
  'src/core/x.ts': 'export const x = 1;\n',
  'src/app.modules.ts': FIXTURE_APP_MODULES,
  'src/features/example/example.ts': 'export const example = 1;\n',
  'src/plans.example.ts':
    "export const examplePlans = { defaultPlan: 'free' };\n",
  'src/migrations/example/Migration20260101000000_starter_plans.ts':
    'export class Migration20260101000000_starter_plans {\n  override name = "Migration20260101000000_starter_plans";\n}\n',
  'README.md': '# Boilerplate\n',
  'CHANGELOG.md':
    '# Changelog\n\n## 0.1.0 (2026-09-29)\n\n### Upgrade notes\n\n- first release\n',
  'package.json': `${JSON.stringify(
    {
      name: 'boilerplate-fixture',
      version: '0.0.1',
      private: true,
      scripts: {
        'upstream:regenerate': 'node tools/fixture/regenerate.mjs',
        'upstream:verify': 'node tools/fixture/verify.mjs',
      },
      dependencies: { zod: '4.6.5' },
    },
    null,
    2,
  )}\n`,
  'pnpm-workspace.yaml':
    'minimumReleaseAge: 1440\nallowBuilds:\n  esbuild: true\n',
  '.env.example': 'A=1\n',
  'tools/fixture/regenerate.mjs':
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('.env.example', 'REGENERATED=1\\n');\n",
  'tools/fixture/verify.mjs': 'process.exitCode = 0;\n',
  'docs/superpowers/ghi chú.md': 'upstream history\n',
};

export type ToolResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export class Repo {
  constructor(readonly dir: string) {}
  git(...args: string[]): string {
    return gitAt(this.dir, args);
  }
  gitRaw(...args: string[]): ToolResult {
    const r = spawnSync('git', args, {
      cwd: this.dir,
      env: gitEnv(),
      encoding: 'utf8',
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }
  read(path: string): string {
    return readFileSync(join(this.dir, path), 'utf8');
  }
  exists(path: string): boolean {
    return existsSync(join(this.dir, path));
  }
  remove(path: string): void {
    unlinkSync(join(this.dir, path));
  }
  commitAll(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
  tool(
    name: 'check' | 'sync' | 'init',
    args: string[] = [],
    input?: string,
  ): ToolResult {
    // Công cụ tự gọi git (và `node --run …`): cùng env hermetic.
    const r = spawnSync(
      process.execPath,
      [join(this.dir, 'tools', 'upstream', `${name}.mjs`), ...args],
      { cwd: this.dir, env: gitEnv(), encoding: 'utf8', input },
    );
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
}

/** Dựng repo trong `dir`; lỗi giữa chừng thì xoá `dir` rồi ném lại (không rò thư mục tạm khi `beforeEach` hỏng). */
function buildOrRemove<T>(dir: string, build: () => T): T {
  try {
    return build();
  } catch (e) {
    rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES });
    throw e;
  }
}

export function createUpstream(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'nsb-upstream-'));
  return buildOrRemove(dir, () => {
    gitAt(dir, ['init', '-q', '-b', 'main', dir]);
    const up = new Repo(dir);
    // sync.mjs, init.mjs, zones.mjs và CODEOWNERS.template có từ Task 7–8; test của mỗi task chỉ dùng công cụ đã có.
    for (const p of COPIED_FROM_REPO)
      if (existsSync(join(REPO_ROOT, p)))
        up.write(p, readFileSync(join(REPO_ROOT, p), 'utf8'));
    for (const [p, c] of Object.entries(FIXTURE_FILES)) up.write(p, c);
    up.commitAll('feat: boilerplate v0.1.0');
    up.git('tag', 'v0.1.0');
    return up;
  });
}

/** Một bản phát hành upstream: đổi file, thêm mục CHANGELOG (kèm "Upgrade notes" nếu có), commit, gắn tag. */
export function releaseUpstream(
  up: Repo,
  tag: string,
  o: { write?: Record<string, string>; remove?: string[]; notes?: string } = {},
): string {
  for (const [p, c] of Object.entries(o.write ?? {})) up.write(p, c);
  for (const p of o.remove ?? []) up.remove(p);
  const notes = o.notes ? `\n### Upgrade notes\n\n- ${o.notes}\n` : '';
  up.write(
    'CHANGELOG.md',
    up
      .read('CHANGELOG.md')
      .replace(
        '# Changelog\n',
        `# Changelog\n\n## ${tag.slice(1)} (2026-10-01)\n${notes}`,
      ),
  );
  const sha = up.commitAll(`feat: boilerplate ${tag}`);
  up.git('tag', tag);
  return sha;
}

export function cloneAtTag(up: Repo, tag: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'nsb-clone-'));
  return buildOrRemove(dir, () => {
    // `-c` ghi vào config của clone TRƯỚC khi checkout (gitEnv đã chặn config hệ thống; đây là lớp thứ hai, tường minh).
    gitAt(tmpdir(), [
      'clone',
      '-q',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      '-c',
      'advice.detachedHead=false',
      '--branch',
      tag,
      up.dir,
      dir,
    ]);
    const r = new Repo(dir);
    r.git('switch', '-q', '-C', 'main');
    r.git('remote', 'rename', 'origin', 'upstream');
    return r;
  });
}

/** Clone ở `tag`, chạy `init.mjs`, commit: trạng thái của một dự án vừa khởi tạo. */
export function initProject(up: Repo, tag = 'v0.1.0'): Repo {
  const r = cloneAtTag(up, tag);
  return buildOrRemove(r.dir, () => {
    const res = r.tool('init', [
      '--team-core',
      '@acme/platform',
      '--team-app',
      '@acme/app',
    ]);
    if (res.status !== 0)
      throw new Error(
        `init failed (${res.status}):\n${res.stdout}${res.stderr}`,
      );
    r.commitAll(`chore: initialize project from boilerplate ${tag}`);
    return r;
  });
}

export function removeRepo(r: Repo | undefined): void {
  if (r)
    rmSync(r.dir, { recursive: true, force: true, maxRetries: RM_RETRIES });
}
