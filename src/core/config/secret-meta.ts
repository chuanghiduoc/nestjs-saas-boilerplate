import type { z } from 'zod';
import type { ConfigEntry } from './config.registry.js';

/** Vai trò process (`APP_ROLE`). Nguồn duy nhất cho schema `app.role` và metadata secret. */
export const APP_ROLES = ['api', 'worker', 'migrate'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export type SecretMeta = { secret: { roles: readonly AppRole[] } };
export type SecretField = { env: string; roles: readonly AppRole[] };

/**
 * Đánh dấu trường secret của schema config: `.meta(secretMeta(['api', 'worker']))`. `roles` là các vai trò được nhận
 * secret này; luật config nào đòi nó chỉ được đòi ở đúng các vai trò đó (spec SP7 §6.5). `pnpm chart:secrets` sinh
 * allowlist của Helm chart và danh sách tên cấm trong ConfigMap từ metadata này.
 */
export function secretMeta(roles: readonly AppRole[]): SecretMeta {
  if (roles.length === 0) throw new Error('secretMeta needs at least one role');
  return { secret: { roles: APP_ROLES.filter((r) => roles.includes(r)) } };
}

type Def = { type: string; innerType?: z.ZodType; in?: z.ZodType };
const defOf = (s: z.ZodType): Def =>
  (s as unknown as { _zod: { def: Def } })._zod.def;
const isRole = (v: unknown): v is AppRole =>
  typeof v === 'string' && (APP_ROLES as readonly string[]).includes(v);

/** `GlobalMeta` của zod có chữ ký chỉ mục `unknown`: kiểm hình dạng lúc đọc, sai thì ném có tên env. */
function rolesFromMeta(
  meta: unknown,
  env: string,
): readonly AppRole[] | undefined {
  if (typeof meta !== 'object' || meta === null || !('secret' in meta))
    return undefined;
  const bad = () =>
    new Error(
      `${env}: .meta({ secret }) must be secretMeta([...]) with roles from ${APP_ROLES.join('|')}`,
    );
  const secret: unknown = meta.secret;
  if (typeof secret !== 'object' || secret === null || !('roles' in secret))
    throw bad();
  const roles: unknown = secret.roles;
  if (!Array.isArray(roles) || roles.length === 0) throw bad();
  const out: AppRole[] = [];
  for (const r of roles as unknown[]) {
    if (!isRole(r)) throw bad();
    out.push(r);
  }
  return APP_ROLES.filter((r) => out.includes(r));
}

/** Vai trò của một trường secret; đi qua wrapper `optional`/`default`/`nullable`/`pipe` như `describeField`. */
export function secretRolesOf(
  field: z.ZodType,
  env: string,
): readonly AppRole[] | undefined {
  let cur: z.ZodType | undefined = field;
  while (cur) {
    const roles = rolesFromMeta(cur.meta(), env);
    if (roles) return roles;
    const d = defOf(cur);
    if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default')
      cur = d.innerType;
    else if (d.type === 'pipe') cur = d.in;
    else cur = undefined;
  }
  return undefined;
}

export function secretFieldsOf(entries: readonly ConfigEntry[]): SecretField[] {
  const out: SecretField[] = [];
  for (const e of entries)
    for (const [key, env] of Object.entries(e.env)) {
      const roles = secretRolesOf(e.schema.shape[key] as z.ZodType, env);
      if (roles) out.push({ env, roles });
    }
  return out.sort((a, b) => a.env.localeCompare(b.env));
}
