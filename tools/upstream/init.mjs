// Khởi tạo dự án từ một clone của boilerplate (spec SP7 §6.3.4, S7-D36). Node ESM thuần, chỉ node:*.
//   node tools/upstream/init.mjs --team-core @org/platform --team-app @org/app
// Chạy MỘT lần trên clone sạch đang ở đúng một tag vX.Y.Z, trước lần deploy production đầu tiên. Không commit.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ZonesError, parseZones, zoneOf } from './zones.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const TEAM = /^@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?$/;
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const PLANS_TEMPLATE = 'src/plans.example.ts';
const PLANS_PROJECT = 'src/app.plans.ts';
const TEMPLATE_MIGRATIONS_DIR = 'src/migrations/example';
const PROJECT_MIGRATIONS_DIR = 'src/migrations/app';
const STARTER_MIGRATION = /^(Migration\d{14})_(starter_[a-z0-9_]+)\.ts$/;
const APP_MODULES = 'src/app.modules.ts';
const TEMPLATE_LINE_MARKER = '// upstream:template';
const PLANS_IMPORT_TEMPLATE = './plans.example.js';
const PLANS_IMPORT_PROJECT = './app.plans.js';
const CODEOWNERS_TEMPLATE = 'docs/upstream/CODEOWNERS.template';
const CODEOWNERS = '.github/CODEOWNERS';
const README = 'README.md';
const TEAM_CORE_TOKEN = '@TEAM_CORE';
const TEAM_APP_TOKEN = '@TEAM_APP';
const MS_PER_SECOND = 1000;
const GIT_RM_BATCH = 100;
/** Tag upstream ở namespace riêng (review M2); `refs/tags/` để dành cho bản phát hành của dự án. */
const UPSTREAM_TAGS = 'refs/upstream-tags/';
const PROJECT_TAGS = 'refs/tags/';

class InitError extends Error {}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function gitExit(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

/** Đúng công thức tên của `mikro-orm migration:create` (@mikro-orm/migrations 7.2.1, MigrationGenerator.js:20). */
const migrationStamp = (d) => d.toISOString().replace(/[-T:]|\.\d{3}z$/gi, '');
const semver = (tag) => TAG.exec(tag).slice(1, 4).map(Number);
function newer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--team-core' && flag !== '--team-app')
      throw new InitError(
        `unknown argument "${flag}"; use --team-core @org/team --team-app @org/team`,
      );
    if (!value || !TEAM.test(value))
      throw new InitError(`${flag} needs a GitHub team or user like @org/team`);
    opts[flag === '--team-core' ? 'teamCore' : 'teamApp'] = value;
  }
  if (!opts.teamCore || !opts.teamApp)
    throw new InitError('both --team-core and --team-app are required');
  return opts;
}

/**
 * Tag phát hành đang ở HEAD. Clone mới có tag upstream ở `refs/tags`; lần chạy lại sau khi hoàn tác có thể đã chuyển
 * chúng sang `refs/upstream-tags` (review M2), nên đọc cả hai.
 */
function releaseTagAtHead() {
  const tags = git(
    'for-each-ref',
    '--points-at',
    'HEAD',
    '--format=%(refname:lstrip=2)',
    PROJECT_TAGS,
    UPSTREAM_TAGS,
  )
    .split('\n')
    .filter((t) => TAG.test(t));
  if (tags.length === 0)
    throw new InitError(
      'HEAD is not a release tag; clone the boilerplate at a tag (git clone --branch vX.Y.Z <url>) and run init before any other commit',
    );
  return tags.reduce((best, t) => (newer(semver(t), semver(best)) ? t : best));
}

/** Kế hoạch chép migration hạt giống (chưa ghi gì): nguồn, đích, nội dung đã đổi tên lớp. */
function planStarterMigrations() {
  if (!existsSync(TEMPLATE_MIGRATIONS_DIR)) return [];
  const starters = readdirSync(TEMPLATE_MIGRATIONS_DIR)
    .filter((f) => STARTER_MIGRATION.test(f))
    .sort();
  const base = Date.now();
  return starters.map((file, i) => {
    const [, oldClass, suffix] = STARTER_MIGRATION.exec(file);
    const oldName = `${oldClass}_${suffix}`;
    const newName = `Migration${migrationStamp(new Date(base + i * MS_PER_SECOND))}_${suffix}`;
    return {
      target: `${PROJECT_MIGRATIONS_DIR}/${newName}.ts`,
      content: readFileSync(
        join(TEMPLATE_MIGRATIONS_DIR, file),
        'utf8',
      ).replaceAll(oldName, newName),
    };
  });
}

function rewrittenAppModules() {
  if (!existsSync(APP_MODULES))
    throw new InitError(
      `${APP_MODULES} is missing; this release cannot initialize a clone`,
    );
  return readFileSync(APP_MODULES, 'utf8')
    .split('\n')
    .filter((l) => !l.trimEnd().endsWith(TEMPLATE_LINE_MARKER))
    .join('\n')
    .replaceAll(PLANS_IMPORT_TEMPLATE, PLANS_IMPORT_PROJECT);
}

/** Tag upstream đã clone chuyển sang `refs/upstream-tags/` (review M2): `refs/tags/v*` để dành cho bản phát hành của dự án. */
function moveUpstreamTags() {
  const refs = git(
    'for-each-ref',
    '--format=%(refname:lstrip=2) %(objectname)',
    PROJECT_TAGS,
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
    .filter(([name]) => TAG.test(name));
  for (const [name, object] of refs) {
    git('update-ref', `${UPSTREAM_TAGS}${name}`, object);
    git('update-ref', '-d', `${PROJECT_TAGS}${name}`);
  }
  return refs.length;
}

const readmeFor = (name, tag) =>
  `# ${name}\n\nDự án clone từ NestJS SaaS Boilerplate ${tag}. Tài liệu của boilerplate: [docs/boilerplate/README.md](docs/boilerplate/README.md). Tài liệu của dự án đặt ở \`docs/app/\`.\n`;

/**
 * Pha 1 (review L1): đọc và kiểm MỌI thứ, không ghi gì. Lỗi ở đây để lại clone nguyên vẹn.
 */
function prepare(argv) {
  const opts = parseArgs(argv);
  if (git('status', '--porcelain') !== '')
    throw new InitError(
      'the working tree is not clean; run init on a fresh clone',
    );
  if (existsSync(VERSION_FILE))
    throw new InitError(
      `${VERSION_FILE} already exists: this clone is already initialized`,
    );
  const tag = releaseTagAtHead();
  if (!existsSync(ZONES_FILE))
    throw new InitError(
      `${ZONES_FILE} is missing; this release cannot initialize a clone`,
    );
  const zones = parseZones(readFileSync(ZONES_FILE, 'utf8'), ZONES_FILE);
  if (!existsSync(CODEOWNERS_TEMPLATE))
    throw new InitError(
      `${CODEOWNERS_TEMPLATE} is missing; this release cannot initialize a clone`,
    );
  return {
    tag,
    commit: git('rev-parse', 'HEAD'),
    plans: existsSync(PLANS_TEMPLATE)
      ? readFileSync(PLANS_TEMPLATE, 'utf8')
      : undefined,
    starters: planStarterMigrations(),
    templatePaths: git('ls-files', '-z')
      .split('\0')
      .filter((p) => p && zoneOf(zones, p).zone === 'template'),
    appModules: rewrittenAppModules(),
    codeowners: readFileSync(CODEOWNERS_TEMPLATE, 'utf8')
      .replaceAll(TEAM_CORE_TOKEN, opts.teamCore)
      .replaceAll(TEAM_APP_TOKEN, opts.teamApp),
  };
}

/**
 * Pha 2: ghi. `.upstream/version.json` (dấu "đã khởi tạo") ghi SAU CÙNG. Lỗi giữa chừng → `rollback` đưa cây về đúng
 * HEAD (cây đã sạch lúc bắt đầu, nên chỉ hoàn tác việc của init), để chạy lại được.
 */
function apply(plan) {
  const created = [];
  const write = (path, content) => {
    if (gitExit('cat-file', '-e', `HEAD:${path}`).status !== 0)
      created.push(path);
    writeFileSync(path, content);
  };
  try {
    const staged = [APP_MODULES, CODEOWNERS, README];
    if (plan.plans !== undefined) {
      write(PLANS_PROJECT, plan.plans);
      staged.push(PLANS_PROJECT);
    }
    if (plan.starters.length)
      mkdirSync(PROJECT_MIGRATIONS_DIR, { recursive: true });
    for (const s of plan.starters) {
      write(s.target, s.content);
      staged.push(s.target);
    }
    for (let i = 0; i < plan.templatePaths.length; i += GIT_RM_BATCH)
      git('rm', '-q', '--', ...plan.templatePaths.slice(i, i + GIT_RM_BATCH));
    write(APP_MODULES, plan.appModules);
    mkdirSync(dirname(CODEOWNERS), { recursive: true });
    write(CODEOWNERS, plan.codeowners);
    write(README, readmeFor(basename(process.cwd()), plan.tag));
    git('add', '--', ...staged);
    const moved = moveUpstreamTags();
    write(
      VERSION_FILE,
      `${JSON.stringify({ tag: plan.tag, commit: plan.commit }, null, 2)}\n`,
    );
    git('add', '--', VERSION_FILE);
    return moved;
  } catch (e) {
    rollback(created);
    throw new InitError(
      `rolled back, the working tree is unchanged (${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
}

function rollback(created) {
  git('reset', '-q', '--hard', 'HEAD');
  for (const p of created)
    if (gitExit('cat-file', '-e', `HEAD:${p}`).status !== 0)
      rmSync(p, { force: true });
}

function main(argv) {
  const plan = prepare(argv);
  const moved = apply(plan);
  process.stdout.write(
    [
      `upstream:init done for ${plan.tag} (${plan.templatePaths.length} template file(s) removed, ${moved} upstream tag(s) moved to ${UPSTREAM_TAGS}). Nothing is committed. Next:`,
      '  1. Review src/app.plans.ts and src/migrations/app/*_starter_* against your real plans (docs/boilerplate/README.md "Khởi tạo dự án").',
      '  2. Billing enabled? Write your price seed migration (docs/boilerplate/README.md "Seed giá cho billing").',
      '  3. git remote rename origin upstream && git config remote.upstream.tagOpt --no-tags && git remote add origin <your repository URL>',
      `  4. git commit -m "chore: initialize project from boilerplate ${plan.tag}"`,
      '  5. Protect main so upstream sync PRs are merged with a merge commit (docs/upstream/merge.md).',
      '',
    ].join('\n'),
  );
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof InitError) && !(e instanceof ZonesError)) throw e;
  process.stderr.write(`upstream:init: ${e.message}\n`);
  if (e.cause instanceof Error && e.cause.stack)
    process.stderr.write(`${e.cause.stack}\n`);
  process.exitCode = 1;
}
