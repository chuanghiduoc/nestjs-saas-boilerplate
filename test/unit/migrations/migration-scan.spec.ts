import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFINER_FUNCTIONS } from '../../support/tenancy-catalog.js';

const ROOT = 'src/migrations';
const CREATE_FN =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_.]*)\s*\(/gi;
const DROP_FN =
  /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_.]*)\s*\(/gi;
const SET_DEFINER = /SET\s+LOCAL\s+ROLE\s+tenancy_definer/gi;
const RESET_ROLE = /RESET\s+ROLE/gi;
const NO_FORCE = /NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
/** Câu `RAISE` của khối khẳng định bước 7 (spec §8.8): mọi migration có `NO FORCE` phải kết thúc bằng khối này. */
const FORCE_ASSERTION = 'a tenant table lost FORCE ROW LEVEL SECURITY';

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

/** Mọi vi phạm của một file migration; rỗng = hợp lệ. Hàm thuần để test chính bộ quét bằng chuỗi xấu. */
function scanMigration(src: string, definers: readonly string[]): string[] {
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
    const sets = positions(body, SET_DEFINER).map((p) => p.at);
    const resets = positions(body, RESET_ROLE).map((p) => p.at);
    if (
      sets.length !== resets.length ||
      sets.some((s, i) => (resets[i] ?? -1) < s)
    )
      problems.push(
        `${label}: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it`,
      );
    const inside = (at: number) =>
      sets.some((s, i) => s < at && at < (resets[i] ?? -1));
    for (const fn of [
      ...positions(body, CREATE_FN),
      ...positions(body, DROP_FN),
    ])
      if (definers.includes(fn.name) && !inside(fn.at))
        problems.push(
          `${label}: definer function ${fn.name} is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE`,
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

describe('migration scanner (spec SP3 §6.13, §18.5)', () => {
  const wrap = (up: string, down: string) =>
    `class M { override up() { ${up} } override down() { ${down} } }`;
  it('catches every forbidden shape', () => {
    expect(scanMigration(wrap('CREATE FUNCTION f() x', ''), [])).toEqual([
      'up creates function f that down never drops',
    ]);
    expect(
      scanMigration(
        wrap(
          'SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x',
          'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        ['g'],
      ),
    ).toContain(
      'up: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it',
    );
    expect(
      scanMigration(
        wrap('CREATE FUNCTION public.g() x', 'DROP FUNCTION public.g()'),
        ['g'],
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
        [],
      ),
    ).toEqual([
      'up: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block',
    ]);
    expect(scanMigration(`${wrap('', '')} isTransactional`, [])).toContain(
      'overrides isTransactional()',
    );
    expect(
      scanMigration(wrap('SET CONSTRAINTS ALL IMMEDIATE', ''), []),
    ).toContain('uses SET CONSTRAINTS ALL');
  });
  it('accepts the correct shape', () => {
    expect(
      scanMigration(
        wrap(
          `SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x; RESET ROLE; ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY; RAISE '${FORCE_ASSERTION}'`,
          'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        ['g'],
      ),
    ).toEqual([]);
  });
  it.each(files(ROOT))('%s passes the scanner', (file) => {
    expect(
      scanMigration(readFileSync(file, 'utf8'), DEFINER_FUNCTIONS),
    ).toEqual([]);
  });
});
