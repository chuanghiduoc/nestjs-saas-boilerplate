import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOLOGIN_OWNER_ROLES,
  OWNED_FUNCTIONS,
  type NologinOwnerRole,
} from '../../support/core-catalog.js';

/** Migration production và fixture của test (fixture 6.0 tạo hàm của `sweep_definer`/`partition_owner`). */
const ROOTS = ['src/migrations', 'test/fixtures/migrations'];
const CREATE_FN =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_.]*)\s*\(/gi;
const DROP_FN =
  /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_.]*)\s*\(/gi;
const SET_ROLE = new RegExp(
  `SET\\s+LOCAL\\s+ROLE\\s+(${NOLOGIN_OWNER_ROLES.join('|')})\\b`,
  'gi',
);
const RESET_ROLE = /RESET\s+ROLE/gi;
const NO_FORCE = /NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
/**
 * Bảng partitioned phải thuộc `partition_owner` (spec SP6 §3.2 luật 1, §6.1). Phần giữa không vượt `;` (câu SQL khác) và
 * không vượt backtick (template literal `addSql` khác): một `CREATE TABLE` thường không có `;` ở cuối chuỗi không được nhận
 * `PARTITION BY` của câu sau (tên bảng sai trong lỗi, hoặc báo nhầm một bảng thường).
 */
const CREATE_PARTITIONED =
  /CREATE\s+TABLE\s+([a-z_][a-z0-9_.]*)\s*\([^;`]*?\)\s*PARTITION\s+BY/gi;
/** Câu `RAISE` của khối khẳng định bước 7 (spec SP3 §8.8): mọi migration có `NO FORCE` phải kết thúc bằng khối này. */
const FORCE_ASSERTION = 'a tenant table lost FORCE ROW LEVEL SECURITY';

type Owned = Readonly<Record<NologinOwnerRole, readonly string[]>>;
type Block = { role: NologinOwnerRole; from: number; to: number };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const bare = (name: string) => name.replace(/^public\./, '');
const positions = (text: string, re: RegExp) =>
  [...text.matchAll(re)].map((m) => ({
    at: m.index ?? -1,
    name: bare(m[1] ?? ''),
  }));

function methodsOf(src: string): { up: string; down: string } {
  const up = src.indexOf('override up(');
  const down = src.indexOf('override down(');
  if (up < 0 || down < up)
    throw new Error(
      'a migration declares override up() and then override down()',
    );
  return { up: src.slice(up, down), down: src.slice(down) };
}

/** Các khối `SET LOCAL ROLE <role> … RESET ROLE`; vấn đề ghép cặp (nếu có) trả trong `problem`. */
function blocksOf(
  label: string,
  body: string,
): { blocks: Block[]; problem?: string } {
  const sets = [...body.matchAll(SET_ROLE)].map((m) => ({
    at: m.index ?? -1,
    role: NOLOGIN_OWNER_ROLES.find((r) => r === (m[1] ?? '').toLowerCase()),
  }));
  const resets = [...body.matchAll(RESET_ROLE)].map((m) => m.index ?? -1);
  const blocks: Block[] = [];
  for (const [i, s] of sets.entries()) {
    const end = resets[i];
    const next = sets[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    if (!s.role || end === undefined || end < s.at || end > next)
      return {
        blocks,
        problem: `${label}: every SET LOCAL ROLE ${s.role ?? '?'} needs a RESET ROLE after it`,
      };
    blocks.push({ role: s.role, from: s.at, to: end });
  }
  if (resets.length !== sets.length)
    return {
      blocks,
      problem: `${label}: RESET ROLE without a matching SET LOCAL ROLE`,
    };
  return { blocks };
}

/** Mọi vi phạm của một file migration; rỗng = hợp lệ. Hàm thuần để test chính bộ quét bằng chuỗi xấu. */
function scanMigration(src: string, owned: Owned): string[] {
  const problems: string[] = [];
  if (/isTransactional/.test(src)) problems.push('overrides isTransactional()');
  if (/SET\s+CONSTRAINTS\s+ALL/i.test(src))
    problems.push('uses SET CONSTRAINTS ALL');
  const { up, down } = methodsOf(src);
  const dropped = new Set(positions(down, DROP_FN).map((p) => p.name));
  for (const { name } of positions(up, CREATE_FN))
    if (!dropped.has(name))
      problems.push(`up creates function ${name} that down never drops`);
  for (const [label, body] of [
    ['up', up],
    ['down', down],
  ] as const) {
    const { blocks, problem } = blocksOf(label, body);
    if (problem) problems.push(problem);
    const inside = (at: number, role: NologinOwnerRole) =>
      blocks.some((b) => b.role === role && b.from < at && at < b.to);
    const fns = [...positions(body, CREATE_FN), ...positions(body, DROP_FN)];
    for (const role of NOLOGIN_OWNER_ROLES)
      for (const fn of fns)
        if (owned[role].includes(fn.name) && !inside(fn.at, role))
          problems.push(
            `${label}: definer function ${fn.name} is created or dropped outside SET LOCAL ROLE ${role} … RESET ROLE`,
          );
    for (const t of positions(body, CREATE_PARTITIONED))
      if (!inside(t.at, 'partition_owner'))
        problems.push(
          `${label}: partitioned table ${t.name} is created outside SET LOCAL ROLE partition_owner … RESET ROLE`,
        );
    const lastNoForce = positions(body, NO_FORCE).at(-1)?.at;
    if (
      lastNoForce !== undefined &&
      !body.slice(lastNoForce).includes(FORCE_ASSERTION)
    )
      problems.push(
        `${label}: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block`,
      );
  }
  return problems;
}

const only = (role: NologinOwnerRole, fns: string[]): Owned => ({
  tenancy_definer: [],
  sweep_definer: [],
  partition_owner: [],
  [role]: fns,
});
const wrap = (up: string, down: string) =>
  `class M { override up() { ${up} } override down() { ${down} } }`;

describe('migration scanner (spec SP3 §6.13, §18.5; SP6 §3.2)', () => {
  it('catches every forbidden shape of 3A', () => {
    expect(
      scanMigration(
        wrap('CREATE FUNCTION f() x', ''),
        only('tenancy_definer', []),
      ),
    ).toEqual(['up creates function f that down never drops']);
    expect(
      scanMigration(
        wrap(
          'SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x',
          'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        only('tenancy_definer', ['g']),
      ),
    ).toContain(
      'up: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it',
    );
    expect(
      scanMigration(
        wrap('CREATE FUNCTION public.g() x', 'DROP FUNCTION public.g()'),
        only('tenancy_definer', ['g']),
      ),
    ).toEqual([
      'up: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
      'down: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
    ]);
    expect(
      scanMigration(
        wrap(
          'ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY',
          '',
        ),
        only('tenancy_definer', []),
      ),
    ).toEqual([
      'up: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block',
    ]);
    expect(
      scanMigration(
        `${wrap('', '')} isTransactional`,
        only('tenancy_definer', []),
      ),
    ).toContain('overrides isTransactional()');
    expect(
      scanMigration(
        wrap('SET CONSTRAINTS ALL IMMEDIATE', ''),
        only('tenancy_definer', []),
      ),
    ).toContain('uses SET CONSTRAINTS ALL');
  });
  it('catches a function of sweep_definer / partition_owner created under the wrong role or no role', () => {
    expect(
      scanMigration(
        wrap(
          'SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.s() x; RESET ROLE',
          'SET LOCAL ROLE sweep_definer; DROP FUNCTION public.s(); RESET ROLE',
        ),
        only('sweep_definer', ['s']),
      ),
    ).toEqual([
      'up: definer function s is created or dropped outside SET LOCAL ROLE sweep_definer … RESET ROLE',
    ]);
    expect(
      scanMigration(
        wrap('CREATE FUNCTION public.m() x', 'DROP FUNCTION public.m()'),
        only('partition_owner', ['m']),
      ),
    ).toHaveLength(2);
  });
  it('catches a partitioned table created outside SET LOCAL ROLE partition_owner', () => {
    expect(
      scanMigration(
        wrap(
          'CREATE TABLE p (a int, b timestamptz, PRIMARY KEY (b, a)) PARTITION BY RANGE (b)',
          'DROP TABLE p',
        ),
        only('partition_owner', []),
      ),
    ).toEqual([
      'up: partitioned table p is created outside SET LOCAL ROLE partition_owner … RESET ROLE',
    ]);
  });
  it('attributes PARTITION BY to the CREATE TABLE of the same addSql string, never to an earlier one without ";"', () => {
    const up =
      'this.addSql(`CREATE TABLE a (x int)`) ' +
      'this.addSql(`SET LOCAL ROLE partition_owner`) ' +
      'this.addSql(`CREATE TABLE p (a int, b timestamptz, PRIMARY KEY (b, a)) PARTITION BY RANGE (b)`) ' +
      'this.addSql(`RESET ROLE`)';
    expect(
      scanMigration(
        wrap(
          up,
          'SET LOCAL ROLE partition_owner; DROP TABLE p; RESET ROLE; DROP TABLE a',
        ),
        only('partition_owner', []),
      ),
    ).toEqual([]);
    const outside =
      'this.addSql(`CREATE TABLE a (x int)`) this.addSql(`CREATE TABLE p (a int) PARTITION BY RANGE (a)`)';
    expect(
      scanMigration(
        wrap(outside, 'DROP TABLE p; DROP TABLE a'),
        only('partition_owner', []),
      ),
    ).toEqual([
      'up: partitioned table p is created outside SET LOCAL ROLE partition_owner … RESET ROLE',
    ]);
  });
  it('accepts the correct shapes of every role', () => {
    expect(
      scanMigration(
        wrap(
          `SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x; RESET ROLE; SET LOCAL ROLE sweep_definer; CREATE FUNCTION public.s() x; RESET ROLE; SET LOCAL ROLE partition_owner; CREATE TABLE p (a int, b timestamptz, PRIMARY KEY (b, a)) PARTITION BY RANGE (b); CREATE FUNCTION public.m() x; RESET ROLE; ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY; RAISE '${FORCE_ASSERTION}'`,
          'SET LOCAL ROLE partition_owner; DROP TABLE p; DROP FUNCTION public.m(); RESET ROLE; SET LOCAL ROLE sweep_definer; DROP FUNCTION public.s(); RESET ROLE; SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        {
          tenancy_definer: ['g'],
          sweep_definer: ['s'],
          partition_owner: ['m'],
        },
      ),
    ).toEqual([]);
  });
  it.each(ROOTS.flatMap(files))('%s passes the scanner', (file) => {
    expect(scanMigration(readFileSync(file, 'utf8'), OWNED_FUNCTIONS)).toEqual(
      [],
    );
  });
});
