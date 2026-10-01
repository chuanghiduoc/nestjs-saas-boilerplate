import type pg from 'pg';
import type { OrgSweepDef } from '../../src/core/sweep/index.js';

const SQL_TYPE = (v: number | boolean | string) =>
  typeof v === 'number'
    ? 'integer'
    : typeof v === 'boolean'
      ? 'boolean'
      : 'text';

/**
 * Hợp đồng chữ ký của một sweep (R-X14, spec SP6 C-8b) đọc từ `pg_proc`: đúng MỘT overload trong `public`; `p_after uuid`,
 * `p_limit integer`; mỗi tên của `extraParams()` là một tham số với kiểu khớp kiểu JS; không tham số nào của hàm bị bỏ trống;
 * `RETURNS TABLE(org_id uuid)`; `SECURITY DEFINER` của `sweep_definer`, `EXECUTE` chỉ cho `app_user`.
 */
export async function sweepSignatureProblems(
  client: pg.Client,
  sweep: Pick<OrgSweepDef, 'definerFunction' | 'extraParams'>,
): Promise<string[]> {
  const fn = sweep.definerFunction;
  const { rows } = await client.query<{
    args: string;
    result: string;
    owner: string;
    secdef: boolean;
    app: boolean;
    pub: boolean;
  }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
            pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
            has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
            has_function_privilege('public', p.oid, 'EXECUTE') AS pub
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [fn],
  );
  const row = rows[0];
  if (!row || rows.length !== 1)
    return [
      `${fn} has ${rows.length} overloads in public (exactly one is required)`,
    ];
  const params = new Map(
    row.args
      .split(', ')
      .filter(Boolean)
      .map((a) => {
        const i = a.indexOf(' ');
        return [a.slice(0, i), a.slice(i + 1)] as const;
      }),
  );
  const problems: string[] = [];
  if (params.get('p_after') !== 'uuid')
    problems.push(`${fn}: p_after must be uuid`);
  if (params.get('p_limit') !== 'integer')
    problems.push(`${fn}: p_limit must be integer`);
  const extra = sweep.extraParams();
  for (const [name, value] of Object.entries(extra)) {
    const actual = params.get(name);
    if (actual === undefined)
      problems.push(`${name} is not a parameter of ${fn}`);
    else if (actual !== SQL_TYPE(value))
      problems.push(
        `${fn}: ${name} is ${actual} but the sweep passes ${SQL_TYPE(value)}`,
      );
  }
  const passed = new Set(['p_after', 'p_limit', ...Object.keys(extra)]);
  for (const name of params.keys())
    if (!passed.has(name))
      problems.push(`${fn}: parameter ${name} is never passed by the sweep`);
  if (row.result !== 'TABLE(org_id uuid)')
    problems.push(
      `${fn} must return TABLE(org_id uuid), returns ${row.result}`,
    );
  if (row.owner !== 'sweep_definer' || !row.secdef || !row.app || row.pub)
    problems.push(
      `${fn} must be SECURITY DEFINER owned by sweep_definer with EXECUTE for app_user only`,
    );
  return problems;
}
