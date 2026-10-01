// Merge một tag upstream vào clone (spec SP7 §13.4; state machine §8.2). Node ESM thuần, chỉ node:*.
//   node tools/upstream/sync.mjs vX.Y.Z      bắt đầu: cây sạch, trên nhánh chore/upstream-vX.Y.Z tạo từ main
//   node tools/upstream/sync.mjs --continue  sau khi đã giải xung đột tay và git add
// Trạng thái suy ra từ git (MERGE_HEAD, path chưa merge), không có file trạng thái. Không commit, không push.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ZonesError, parseZones, zoneOf } from './zones.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const BRANCH_PREFIX = 'chore/upstream-';
const REMOTE = 'upstream';
const UPSTREAM_MAIN = 'upstream/main';
/**
 * Tag của upstream nằm ở namespace riêng (review M2): dự án gắn tag `vX.Y.Z` cho bản phát hành của CHÍNH nó
 * (`release.yml` chạy theo `v*`), nên `git fetch --tags` của upstream sẽ đụng tag cùng tên ("would clobber").
 */
const UPSTREAM_TAGS = 'refs/upstream-tags/';
const UPSTREAM_FETCH_REFSPECS = [
  `+refs/heads/main:refs/remotes/${UPSTREAM_MAIN}`,
  `+refs/tags/v*:${UPSTREAM_TAGS}v*`,
];
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const CHANGELOG = 'CHANGELOG.md';
const CHECK_SCRIPT = 'tools/upstream/check.mjs';
const REGENERATE_SCRIPT = 'upstream:regenerate';
const VERIFY_SCRIPT = 'upstream:verify';
const EXIT_MANUAL = 3;
const IN_PROGRESS = [
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
];
const AUTO_ZONES = new Set(['boilerplate', 'template', 'generated']);
const GIT_RM_BATCH = 100;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

class SyncError extends Error {}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function gitExit(...args) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error) throw r.error;
  return r;
}
const zList = (out) => out.split('\0').filter(Boolean);
const exists = (rev, path) =>
  gitExit('cat-file', '-e', `${rev}:${path}`).status === 0;
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new SyncError(
      `${[cmd, ...args].join(' ')} failed with exit ${r.status}`,
    );
}

const semver = (tag) => TAG.exec(tag).slice(1, 4).map(Number);
function newer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function readRecorded() {
  if (!existsSync(VERSION_FILE))
    throw new SyncError(
      `${VERSION_FILE} is missing; run pnpm upstream:init first`,
    );
  const v = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
  if (typeof v?.tag !== 'string' || !TAG.test(v.tag))
    throw new SyncError(`${VERSION_FILE}: "tag" must look like vX.Y.Z`);
  return v;
}
const upstreamTagRef = (tag) => `${UPSTREAM_TAGS}${tag}`;
function tagOf(commit) {
  const tags = git(
    'for-each-ref',
    '--points-at',
    commit,
    '--format=%(refname:lstrip=2)',
    UPSTREAM_TAGS,
  )
    .split('\n')
    .filter((t) => TAG.test(t));
  if (tags.length === 0)
    throw new SyncError(`no release tag points at ${commit}`);
  return tags.reduce((best, t) => (newer(semver(t), semver(best)) ? t : best));
}

/** Mục "### Upgrade notes" của mọi bản trong (from, to] (spec 13.4 bước 2). */
function upgradeNotes(changelog, fromTag, toTag) {
  const from = semver(fromTag);
  const to = semver(toTag);
  const out = [];
  for (const section of changelog.split(/^## /m).slice(1)) {
    const m = /^\[?(\d+)\.(\d+)\.(\d+)\]?/.exec(section);
    if (!m) continue;
    const v = m.slice(1, 4).map(Number);
    if (!newer(v, from) || newer(v, to)) continue;
    const notes =
      /^### Upgrade notes[ \t]*\r?\n([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(
        section,
      );
    out.push(
      `## ${v.join('.')}\n${notes ? notes[1].trim() : '(no upgrade notes)'}`,
    );
  }
  return out.length
    ? out.join('\n\n')
    : '(no CHANGELOG entry between the two tags)';
}

/** Hỏi một dòng; stdin đóng trước khi trả lời là lỗi (không bao giờ coi như đã xác nhận). */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.once('close', () => {
      if (!answered)
        reject(
          new SyncError(
            'stdin closed before the confirmation was typed; nothing changed',
          ),
        );
    });
    rl.question(question).then(
      (a) => {
        answered = true;
        rl.close();
        resolve(a);
      },
      (e) => {
        answered = true;
        rl.close();
        reject(e);
      },
    );
  });
}

function detectState() {
  const gitDir = git('rev-parse', '--git-dir');
  for (const marker of IN_PROGRESS)
    if (existsSync(join(gitDir, marker)))
      throw new SyncError(
        `a git operation (${marker}) is in progress; finish or abort it first`,
      );
  if (gitExit('rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0)
    return { kind: 'CLEAN' };
  const mergeHead = git('rev-parse', 'MERGE_HEAD^{commit}');
  const zones = parseZones(
    git('show', `${mergeHead}:${ZONES_FILE}`),
    `${ZONES_FILE}@MERGE_HEAD`,
  );
  const unmerged = zList(git('diff', '--name-only', '-z', '--diff-filter=U'));
  const auto = unmerged.filter((p) => AUTO_ZONES.has(zoneOf(zones, p).zone));
  if (auto.length)
    return { kind: 'MERGING_AUTO', mergeHead, zones, paths: auto };
  if (unmerged.length)
    return { kind: 'MERGING_MANUAL', mergeHead, zones, paths: unmerged };
  return readRecorded().commit === mergeHead
    ? { kind: 'VERIFY', mergeHead, zones }
    : { kind: 'REGENERATE', mergeHead, zones };
}

async function start(tag) {
  if (!TAG.test(tag))
    throw new SyncError(`"${tag}" is not a release tag like vX.Y.Z`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.startsWith(BRANCH_PREFIX))
    throw new SyncError(
      `run sync on a new branch named ${BRANCH_PREFIX}${tag} created from main (current: ${branch})`,
    );
  if (git('status', '--porcelain') !== '')
    throw new SyncError('the working tree is not clean');
  if (gitExit('remote', 'get-url', REMOTE).status !== 0)
    throw new SyncError(
      `remote "${REMOTE}" is missing: git remote add ${REMOTE} <boilerplate URL>`,
    );
  run('git', [
    'fetch',
    '--quiet',
    '--no-tags',
    REMOTE,
    ...UPSTREAM_FETCH_REFSPECS,
  ]);
  const ref = upstreamTagRef(tag);
  if (gitExit('rev-parse', '-q', '--verify', ref).status !== 0)
    throw new SyncError(`tag ${tag} does not exist on ${REMOTE}`);
  if (gitExit('rev-parse', '-q', '--verify', UPSTREAM_MAIN).status !== 0)
    throw new SyncError(`${UPSTREAM_MAIN} is missing: git fetch ${REMOTE}`);
  const target = git('rev-parse', `${ref}^{commit}`);
  const onMain = gitExit('merge-base', '--is-ancestor', target, UPSTREAM_MAIN);
  if (onMain.status === 1)
    throw new SyncError(
      `${tag} is not on ${UPSTREAM_MAIN}; only release tags of the main line can be synced`,
    );
  if (onMain.status !== 0)
    throw new SyncError(`git merge-base failed: ${onMain.stderr.trim()}`);
  const current = readRecorded();
  if (!newer(semver(tag), semver(current.tag)))
    throw new SyncError(`${tag} is not newer than the current ${current.tag}`);
  process.stdout.write(
    `Upgrade notes ${current.tag} -> ${tag}:\n\n${upgradeNotes(git('show', `${ref}:${CHANGELOG}`), current.tag, tag)}\n\n`,
  );
  const answer = await ask(
    `Type ${tag} to confirm you have read the upgrade notes: `,
  );
  if (answer.trim() !== tag)
    throw new SyncError('upgrade notes not confirmed; nothing changed');
  const merge = gitExit(
    'merge',
    '--no-ff',
    '--no-commit',
    '-m',
    `Merge upstream ${tag}`,
    ref,
  );
  if (gitExit('rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0)
    throw new SyncError(
      `git merge ${tag} did not start a merge:\n${merge.stdout}${merge.stderr}`,
    );
}

function autoResolve({ mergeHead, zones, paths }) {
  for (const p of paths) {
    const { zone } = zoneOf(zones, p);
    if (zone === 'template' && !exists('HEAD', p)) git('rm', '-q', '--', p);
    else if (exists(mergeHead, p)) {
      git('checkout', '--theirs', '--', p);
      git('add', '--', p);
    } else git('rm', '-q', '--', p);
    process.stdout.write(`auto-resolved ${p} (${zone})\n`);
  }
}

/**
 * Vùng template giữ trạng thái đã xoá THEO TỪNG MỤC của `zones.json` (review L2): mục template nào không còn path nào ở
 * HEAD (dự án đã xoá nó) thì file upstream mang tới dưới mục đó cũng bị xoá; mục dự án còn giữ thì nhận file mới.
 */
function keepTemplateDeleted(zones) {
  const templateEntry = (p) => {
    const at = zoneOf(zones, p);
    return at.zone === 'template' ? at.pattern : undefined;
  };
  const kept = new Set(
    zList(git('ls-tree', '-r', '-z', '--name-only', 'HEAD'))
      .map(templateEntry)
      .filter(Boolean),
  );
  const incoming = zList(git('ls-files', '-z')).filter((p) => {
    const entry = templateEntry(p);
    return entry !== undefined && !kept.has(entry);
  });
  for (let i = 0; i < incoming.length; i += GIT_RM_BATCH)
    git('rm', '-q', '-f', '--', ...incoming.slice(i, i + GIT_RM_BATCH));
  return incoming;
}

function regenerate({ mergeHead, zones }) {
  const dropped = keepTemplateDeleted(zones);
  if (dropped.length)
    process.stdout.write(
      `kept the template zone deleted: ${dropped.join(', ')}\n`,
    );
  run(process.execPath, ['--run', REGENERATE_SCRIPT]);
  writeFileSync(
    VERSION_FILE,
    `${JSON.stringify({ tag: tagOf(mergeHead), commit: mergeHead }, null, 2)}\n`,
  );
  const generated = zones.entries
    .filter((e) => e.zone === 'generated' && existsSync(e.pattern))
    .map((e) => e.pattern);
  git('add', '--', VERSION_FILE, ...generated);
}

/**
 * Kiểm chạy trên kết quả merge ĐÃ STAGE (commit tạm từ index), còn lint/test chạy trên cây làm việc: hai bên phải trùng
 * nhau (review L3). Thay đổi chưa stage hoặc file chưa track → từ chối, liệt kê path.
 */
function refuseUnstaged() {
  // Không `git()` (nó `trim()`): khoảng trắng đầu của mã trạng thái " M" là dữ liệu.
  const status = gitExit(
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
  );
  if (status.status !== 0)
    throw new SyncError(`git status failed: ${status.stderr.trim()}`);
  const records = zList(status.stdout);
  const dirty = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const [x, y] = rec;
    // Đổi tên/chép có thêm một bản ghi path nguồn ngay sau (định dạng -z của porcelain v1).
    if (x === 'R' || x === 'C') i += 1;
    if (rec.startsWith('??') || y !== ' ') dirty.push(rec.slice(3));
  }
  if (dirty.length === 0) return;
  throw new SyncError(
    `verification runs on the staged merge result; stage or discard these changes first, then run --continue:\n${dirty.map((p) => `  ${p}`).join('\n')}`,
  );
}

function verify({ mergeHead }) {
  refuseUnstaged();
  // Merge chưa commit và HEAD vẫn là phía dự án: kiểm vùng trên một commit tạm của kết quả (không cập nhật ref nào).
  const probe = git(
    'commit-tree',
    git('write-tree'),
    '-p',
    'HEAD',
    '-p',
    mergeHead,
    '-m',
    'upstream:sync verification (not a ref)',
  );
  run(process.execPath, [CHECK_SCRIPT, '--rev', probe]);
  run(process.execPath, ['--run', VERIFY_SCRIPT]);
}

function printManual({ zones, paths }) {
  process.stderr.write(
    'upstream:sync: resolve these conflicts by hand (docs/upstream/merge.md), git add them, then run pnpm upstream:sync --continue\n',
  );
  for (const p of paths)
    process.stderr.write(`  ${p} (${zoneOf(zones, p).zone})\n`);
}

function printDone({ mergeHead }) {
  const tag = tagOf(mergeHead);
  process.stdout.write(
    [
      `upstream:sync done: ${tag} is merged, regenerated and verified. Nothing is committed. Next:`,
      '  git commit --no-edit',
      `  git push -u origin ${BRANCH_PREFIX}${tag}`,
      '  Open a PR and merge it with "Create a merge commit" — never squash or rebase (docs/upstream/merge.md).',
      '',
    ].join('\n'),
  );
}

async function main(argv) {
  if (argv.length !== 1 || !argv[0])
    throw new SyncError('usage: sync.mjs vX.Y.Z | --continue');
  let state = detectState();
  if (argv[0] === '--continue') {
    if (state.kind === 'CLEAN')
      throw new SyncError('--continue: no upstream merge is in progress');
  } else {
    if (state.kind !== 'CLEAN')
      throw new SyncError(
        'a merge is already in progress; resolve it and run --continue, or git merge --abort',
      );
    await start(argv[0]);
    state = detectState();
  }
  for (;;) {
    switch (state.kind) {
      case 'MERGING_AUTO':
        autoResolve(state);
        break;
      case 'MERGING_MANUAL':
        printManual(state);
        return EXIT_MANUAL;
      case 'REGENERATE':
        regenerate(state);
        break;
      case 'VERIFY':
        verify(state);
        printDone(state); // DONE
        return 0;
      case 'CLEAN':
        throw new SyncError('no merge is in progress after starting one');
      default:
        throw new SyncError(`unrecognized sync state ${state.kind}`);
    }
    state = detectState();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof SyncError || e instanceof ZonesError)
      process.stderr.write(`upstream:sync: ${e.message}\n`);
    else
      process.stderr.write(
        `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
    process.exitCode = 1;
  },
);
