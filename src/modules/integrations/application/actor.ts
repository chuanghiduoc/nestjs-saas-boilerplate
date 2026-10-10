import type { RequestContext } from '../../../core/context/index.js';
import type { EventActor } from '../../../core/events/index.js';

/**
 * Actor của thao tác trực tiếp của user (mẫu `userActor` của tenancy): `webhooks.write` không `apiKeyEligible`, không
 * `supportEligible`, nên principal khác user tới được đây là lỗi lắp ráp: ném to.
 */
export function userActor(ctx: RequestContext): EventActor {
  const p = ctx.principal();
  if (!p) throw new Error('an integrations mutation ran without a principal');
  if (p.type !== 'user')
    throw new Error(`an integrations mutation ran with a ${p.type} principal`);
  return { type: 'user', id: p.id };
}
