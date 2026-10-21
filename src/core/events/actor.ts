import type { RequestContext } from '../context/index.js';
import type { EventActor } from './envelope.js';

/**
 * Actor của event theo principal của request (spec SP3 §14): user → `user`; org API key → `service` `api_key:<id>`; service
 * principal → `service`. Không có principal (job, migration) → `undefined`: caller chọn actor hệ thống của mình hoặc ném.
 */
export function principalActor(ctx: RequestContext): EventActor | undefined {
  const p = ctx.principal();
  if (!p) return undefined;
  switch (p.type) {
    case 'user':
      return { type: 'user', id: p.id };
    case 'api_key':
      return { type: 'service', id: `api_key:${p.id}` };
    case 'service':
      return { type: 'service', id: p.id };
    default: {
      const unknown: never = p.type;
      throw new Error(`unknown principal type ${String(unknown)}`);
    }
  }
}

/**
 * Actor của thao tác chỉ user làm được (route đòi quyền không `apiKeyEligible` hoặc `@SessionOnly`): principal khác user tới
 * được đây là lỗi lắp ráp, ném to và nêu `scope`.
 */
export function userActor(ctx: RequestContext, scope: string): EventActor {
  const p = ctx.principal();
  if (!p)
    throw new Error(
      `a user-initiated ${scope} mutation ran without a principal`,
    );
  if (p.type !== 'user')
    throw new Error(
      `a user-initiated ${scope} mutation ran with a ${p.type} principal`,
    );
  return { type: 'user', id: p.id };
}
