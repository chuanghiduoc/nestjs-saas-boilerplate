import { describe, expect, it } from 'vitest';
import {
  REQUIRE_FRESH_SESSION,
  REQUIRE_VERIFIED_EMAIL,
} from '../../../../src/modules/identity/http/fresh-session.decorator.js';
import { SESSION_ONLY } from '../../../../src/modules/identity/http/session-only.decorator.js';
import { WebhookEndpointsController } from '../../../../src/modules/integrations/http/webhook-endpoints.controller.js';

const GUARDS = [
  SESSION_ONLY,
  REQUIRE_FRESH_SESSION,
  REQUIRE_VERIFIED_EMAIL,
] as const;
type Route =
  | 'create'
  | 'updateDestination'
  | 'rotateSecret'
  | 'update'
  | 'remove'
  | 'list'
  | 'get';
const guardsOf = (route: Route): unknown[] =>
  GUARDS.map(
    (key) =>
      Reflect.getMetadata(key, WebhookEndpointsController.prototype[route]) ===
      true,
  );

/**
 * R-X34, S6-A35: mọi route đổi nơi dữ liệu của org được gửi tới (tạo, đổi đích, xoay secret) mang đủ ba guard của
 * `AuthGuard`. HTTP không cô lập được `SessionOnly` (không API key nào giữ được `webhooks.write`), nên khẳng định ở metadata.
 */
describe('webhook endpoint route guards (R-X34)', () => {
  it.each(['create', 'updateDestination', 'rotateSecret'] as const)(
    '%s is session-only, fresh and verified',
    (route) => {
      expect(guardsOf(route)).toEqual([true, true, true]);
    },
  );
  it.each(['update', 'remove', 'list', 'get'] as const)(
    '%s keeps the ordinary permission rules',
    (route) => {
      expect(guardsOf(route)).toEqual([false, false, false]);
    },
  );
});
