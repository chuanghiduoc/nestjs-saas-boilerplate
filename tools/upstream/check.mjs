// Guard vùng sở hữu (spec SP7 §13.2, §13.3). MỘT file, chỉ node:*, không import tương đối: chạy được từ stdin,
//   git show <commit>:tools/upstream/check.mjs | node --input-type=module -
// để bản ở HEAD (vùng boilerplate) không tự nới luật được. Dùng:
//   node tools/upstream/check.mjs [--rev <commit>]   clone: so HEAD (hoặc <commit>) với commit upstream đã ghi
//   node tools/upstream/check.mjs --self             repo upstream: mọi file được track đều được phân vùng (UP-9)
import { execFileSync, spawnSync } from 'node:child_process';

const TAG = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const ZONE_NAMES = [
  'boilerplate',
  'project',
  'template',
  'generated',
  'shared',
];
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const PACKAGE_FILE = 'package.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const PACKAGE_DEP_KEYS = ['dependencies', 'devDependencies'];
const PACKAGE_EQUAL_KEYS = ['type', 'packageManager', 'engines', 'pnpm'];
const PROJECT_SCRIPT_PREFIX = 'app:';
const UPSTREAM_DOCS_PREFIX = 'docs/superpowers/';
const PROJECT_DOCS_HINT =
  'project documents belong in docs/app/; docs/superpowers/ is upstream history';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

class CheckError extends Error {}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function gitExit(args) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error) throw r.error;
  return r;
}
const pathExists = (rev, path) =>
  gitExit(['cat-file', '-e', `${rev}:${path}`]).status === 0;
function isAncestor(ancestor, rev) {
  const r = gitExit(['merge-base', '--is-ancestor', ancestor, rev]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new CheckError(
    `git merge-base --is-ancestor failed: ${r.stderr.trim()}`,
  );
}

/** path → { mode, oid } của cây ở `rev`; `-z` để path có khoảng trắng/ký tự ngoài ASCII không bị quote. */
function lsTree(rev) {
  const map = new Map();
  for (const rec of git(['ls-tree', '-r', '-z', '--full-tree', rev]).split(
    '\0',
  )) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), { mode, oid });
  }
  return map;
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CheckError(
      `${source}: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function matches(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}
const weight = (pattern) =>
  pattern.endsWith('*') ? pattern.length - 1 : pattern.length;
/** Tiền tố dài nhất thắng; không khớp mục nào → vùng dự án (không tường minh). */
function zoneOf(zones, path) {
  let best;
  for (const e of zones.entries)
    if (
      matches(e.pattern, path) &&
      (!best || weight(e.pattern) > weight(best.pattern))
    )
      best = e;
  return best
    ? { zone: best.zone, explicit: true }
    : { zone: 'project', explicit: false };
}

function parseZones(text, source) {
  const z = parseJson(text, source);
  if (z?.version !== 1) throw new CheckError(`${source}: "version" must be 1`);
  const entries = [];
  const owner = new Map();
  for (const zone of ZONE_NAMES) {
    const list = z[zone];
    if (
      !Array.isArray(list) ||
      list.some((p) => typeof p !== 'string' || p === '')
    )
      throw new CheckError(
        `${source}: "${zone}" must be an array of non-empty strings`,
      );
    for (const pattern of list) {
      if (owner.has(pattern))
        throw new CheckError(
          `${source}: "${pattern}" is listed in both ${owner.get(pattern)} and ${zone}`,
        );
      owner.set(pattern, zone);
      entries.push({ pattern, zone });
    }
  }
  const zones = { entries, projectSeed: new Set() };
  if (!Array.isArray(z.projectSeed))
    throw new CheckError(`${source}: "projectSeed" must be an array`);
  for (const seed of z.projectSeed) {
    const at = zoneOf(zones, seed);
    if (!at.explicit || at.zone !== 'project')
      throw new CheckError(
        `${source}: projectSeed "${seed}" is not an explicit project-zone path`,
      );
    zones.projectSeed.add(seed);
  }
  return zones;
}

function readVersion(rev) {
  if (!pathExists(rev, VERSION_FILE))
    throw new CheckError(
      `${VERSION_FILE} is missing at ${rev}; a clone creates it with pnpm upstream:init, the upstream repository runs --self`,
    );
  const v = parseJson(git(['show', `${rev}:${VERSION_FILE}`]), VERSION_FILE);
  if (typeof v?.tag !== 'string' || !TAG.test(v.tag))
    throw new CheckError(`${VERSION_FILE}: "tag" must look like vX.Y.Z`);
  if (typeof v.commit !== 'string' || !SHA.test(v.commit))
    throw new CheckError(
      `${VERSION_FILE}: "commit" must be a full 40-character lowercase commit SHA`,
    );
  return v;
}

const showText = (rev, path) =>
  pathExists(rev, path) ? git(['show', `${rev}:${path}`]) : undefined;

function checkPackageJson(upstream, rev, out) {
  const upText = showText(upstream, PACKAGE_FILE);
  if (upText === undefined) return;
  const headText = showText(rev, PACKAGE_FILE);
  if (headText === undefined)
    return out.push({ path: PACKAGE_FILE, kind: 'deleted (shared zone)' });
  const up = parseJson(upText, `${PACKAGE_FILE}@upstream`);
  const head = parseJson(headText, PACKAGE_FILE);
  for (const key of PACKAGE_DEP_KEYS)
    for (const [name, spec] of Object.entries(up[key] ?? {}))
      if (head[key]?.[name] !== spec)
        out.push({
          path: PACKAGE_FILE,
          kind: `${key}.${name} must stay ${spec} (upstream), found ${head[key]?.[name] ?? 'nothing'}`,
        });
  const upScripts = up.scripts ?? {};
  for (const [name, command] of Object.entries(upScripts))
    if (head.scripts?.[name] !== command)
      out.push({
        path: PACKAGE_FILE,
        kind: `scripts.${name} must stay as upstream`,
      });
  for (const name of Object.keys(head.scripts ?? {}))
    if (
      !Object.hasOwn(upScripts, name) &&
      !name.startsWith(PROJECT_SCRIPT_PREFIX)
    )
      out.push({
        path: PACKAGE_FILE,
        kind: `scripts.${name}: project scripts must start with "${PROJECT_SCRIPT_PREFIX}"`,
      });
  for (const key of PACKAGE_EQUAL_KEYS)
    if (JSON.stringify(up[key]) !== JSON.stringify(head[key]))
      out.push({ path: PACKAGE_FILE, kind: `${key} must equal upstream` });
}

/** Mỗi dòng không phải chú thích, gắn với khoá cấp một chứa nó ("khoá␀dòng"). */
function workspaceLines(text) {
  const out = new Set();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const body = line.trim();
    if (body === '' || body.startsWith('#')) continue;
    if (!/^\s/.test(line)) section = body;
    out.add(`${section}\u0000${body}`);
  }
  return out;
}
function checkWorkspace(upstream, rev, out) {
  const upText = showText(upstream, WORKSPACE_FILE);
  if (upText === undefined) return;
  const head = workspaceLines(showText(rev, WORKSPACE_FILE) ?? '');
  for (const entry of workspaceLines(upText))
    if (!head.has(entry))
      out.push({
        path: WORKSPACE_FILE,
        kind: `upstream line "${entry.split('\u0000')[1]}" is missing or changed`,
      });
}

function checkClone(rev) {
  const version = readVersion(rev);
  if (gitExit(['cat-file', '-e', `${version.commit}^{commit}`]).status !== 0)
    throw new CheckError(
      `upstream commit ${version.commit} (${version.tag}) is not in this repository; fetch full history (actions/checkout fetch-depth: 0)`,
    );
  if (!isAncestor(version.commit, rev))
    throw new CheckError(
      `upstream commit ${version.commit} (${version.tag}) is not in history (squash-merged sync PR?); see docs/upstream/merge.md "Khôi phục sau squash"`,
    );
  const zones = parseZones(
    git(['show', `${version.commit}:${ZONES_FILE}`]),
    `${ZONES_FILE}@${version.tag}`,
  );
  const up = lsTree(version.commit);
  const head = lsTree(rev);
  const out = [];
  for (const path of new Set([...up.keys(), ...head.keys()])) {
    const { zone } = zoneOf(zones, path);
    const u = up.get(path);
    const h = head.get(path);
    const same = u && h && u.oid === h.oid && u.mode === h.mode;
    if (zone === 'boilerplate') {
      if (!u) out.push({ path, kind: 'added in the boilerplate zone' });
      else if (!h)
        out.push({ path, kind: 'deleted from the boilerplate zone' });
      else if (!same)
        out.push({ path, kind: 'modified in the boilerplate zone' });
    } else if (zone === 'template' && h) {
      if (!u) out.push({ path, kind: 'added in the template zone' });
      else if (!same)
        out.push({
          path,
          kind: 'modified in the template zone (delete it instead)',
        });
    }
  }
  checkPackageJson(version.commit, rev, out);
  checkWorkspace(version.commit, rev, out);
  return out;
}

function checkSelf(rev) {
  const zones = parseZones(git(['show', `${rev}:${ZONES_FILE}`]), ZONES_FILE);
  const out = [];
  for (const path of lsTree(rev).keys()) {
    const { zone, explicit } = zoneOf(zones, path);
    if (!explicit)
      out.push({ path, kind: 'is not classified by .upstream/zones.json' });
    else if (zone === 'project' && !zones.projectSeed.has(path))
      out.push({
        path,
        kind: 'is in the project zone but not in projectSeed; upstream must not track it',
      });
  }
  return out;
}

function parseArgs(argv) {
  const opts = { rev: 'HEAD', self: false, revGiven: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self') opts.self = true;
    else if (a === '--rev') {
      const value = argv[i + 1];
      if (!value) throw new CheckError('--rev needs a commit');
      opts.rev = value;
      opts.revGiven = true;
      i += 1;
    } else
      throw new CheckError(
        `unknown argument "${a}"; use [--rev <commit>] [--self]`,
      );
  }
  return opts;
}

function warnUncommitted() {
  const dirty = git(['status', '--porcelain', '-z'])
    .split('\0')
    .filter(Boolean);
  if (dirty.length === 0) return;
  process.stderr.write(
    `upstream:check: warning: uncommitted changes are not checked (the guard compares commits):\n${dirty.map((d) => `  ${d}`).join('\n')}\n`,
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.revGiven) warnUncommitted();
  const violations = opts.self ? checkSelf(opts.rev) : checkClone(opts.rev);
  if (violations.length === 0) {
    process.stdout.write(
      `upstream:check OK (${opts.self ? 'self' : opts.rev})\n`,
    );
    return 0;
  }
  for (const v of violations)
    process.stderr.write(
      `${v.path}: ${v.kind}${v.path.startsWith(UPSTREAM_DOCS_PREFIX) ? ` (${PROJECT_DOCS_HINT})` : ''}\n`,
    );
  process.stderr.write(
    `upstream:check found ${violations.length} violation(s)\n`,
  );
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CheckError)) throw e;
  process.stderr.write(`upstream:check: ${e.message}\n`);
  process.exitCode = 1;
}
