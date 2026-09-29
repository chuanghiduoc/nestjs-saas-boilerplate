// Khởi tạo dự án từ một clone của boilerplate (spec SP7 §6.3.4, S7-D36). Node ESM thuần, chỉ node:*.
//   node tools/upstream/init.mjs --team-core @org/platform --team-app @org/app
// Chạy MỘT lần trên clone sạch đang ở đúng một tag vX.Y.Z, trước lần deploy production đầu tiên. Không commit.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
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

class InitError extends Error {}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

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

function releaseTagAtHead() {
  const tags = git('tag', '--points-at', 'HEAD')
    .split('\n')
    .filter((t) => TAG.test(t));
  if (tags.length === 0)
    throw new InitError(
      'HEAD is not a release tag; clone the boilerplate at a tag (git clone --branch vX.Y.Z <url>) and run init before any other commit',
    );
  return tags.reduce((best, t) => (newer(semver(t), semver(best)) ? t : best));
}

function copyStarterMigrations() {
  if (!existsSync(TEMPLATE_MIGRATIONS_DIR)) return [];
  const starters = readdirSync(TEMPLATE_MIGRATIONS_DIR)
    .filter((f) => STARTER_MIGRATION.test(f))
    .sort();
  const base = Date.now();
  return starters.map((file, i) => {
    const [, oldClass, suffix] = STARTER_MIGRATION.exec(file);
    const oldName = `${oldClass}_${suffix}`;
    const newName = `Migration${migrationStamp(new Date(base + i * MS_PER_SECOND))}_${suffix}`;
    mkdirSync(PROJECT_MIGRATIONS_DIR, { recursive: true });
    const target = `${PROJECT_MIGRATIONS_DIR}/${newName}.ts`;
    writeFileSync(
      target,
      readFileSync(join(TEMPLATE_MIGRATIONS_DIR, file), 'utf8').replaceAll(
        oldName,
        newName,
      ),
    );
    return target;
  });
}

function removeTemplateZone(zones) {
  const paths = git('ls-files', '-z')
    .split('\0')
    .filter((p) => p && zoneOf(zones, p).zone === 'template');
  for (let i = 0; i < paths.length; i += GIT_RM_BATCH)
    git('rm', '-q', '--', ...paths.slice(i, i + GIT_RM_BATCH));
  return paths;
}

function rewriteAppModules() {
  const lines = readFileSync(APP_MODULES, 'utf8')
    .split('\n')
    .filter((l) => !l.trimEnd().endsWith(TEMPLATE_LINE_MARKER));
  writeFileSync(
    APP_MODULES,
    lines.join('\n').replaceAll(PLANS_IMPORT_TEMPLATE, PLANS_IMPORT_PROJECT),
  );
}

const readmeFor = (name, tag) =>
  `# ${name}\n\nDự án clone từ NestJS SaaS Boilerplate ${tag}. Tài liệu của boilerplate: [docs/boilerplate/README.md](docs/boilerplate/README.md). Tài liệu của dự án đặt ở \`docs/app/\`.\n`;

function main(argv) {
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
  const commit = git('rev-parse', 'HEAD');
  const zones = parseZones(readFileSync(ZONES_FILE, 'utf8'), ZONES_FILE);

  mkdirSync('.upstream', { recursive: true });
  writeFileSync(VERSION_FILE, `${JSON.stringify({ tag, commit }, null, 2)}\n`);
  const written = [VERSION_FILE, APP_MODULES, CODEOWNERS, README];
  if (existsSync(PLANS_TEMPLATE)) {
    writeFileSync(PLANS_PROJECT, readFileSync(PLANS_TEMPLATE, 'utf8'));
    written.push(PLANS_PROJECT);
  }
  written.push(...copyStarterMigrations());
  const removed = removeTemplateZone(zones);
  rewriteAppModules();
  mkdirSync('.github', { recursive: true });
  writeFileSync(
    CODEOWNERS,
    readFileSync(CODEOWNERS_TEMPLATE, 'utf8')
      .replaceAll(TEAM_CORE_TOKEN, opts.teamCore)
      .replaceAll(TEAM_APP_TOKEN, opts.teamApp),
  );
  writeFileSync(README, readmeFor(basename(process.cwd()), tag));
  git('add', '--', ...written);

  process.stdout.write(
    [
      `upstream:init done for ${tag} (${removed.length} template file(s) removed). Nothing is committed. Next:`,
      '  1. Review src/app.plans.ts and src/migrations/app/*_starter_* against your real plans (docs/boilerplate/README.md "Khởi tạo dự án").',
      '  2. Billing enabled? Write your price seed migration (docs/boilerplate/README.md "Seed giá cho billing").',
      '  3. git remote rename origin upstream && git remote add origin <your repository URL>',
      `  4. git commit -m "chore: initialize project from boilerplate ${tag}"`,
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
  process.exitCode = 1;
}
