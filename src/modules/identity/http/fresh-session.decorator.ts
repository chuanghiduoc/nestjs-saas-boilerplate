import { SetMetadata } from '@nestjs/common';

export const REQUIRE_FRESH_SESSION = 'identity:requireFreshSession';
export const REQUIRE_VERIFIED_EMAIL = 'identity:requireVerifiedEmail';
/** Spec SP3 §5.2: thao tác nhạy cảm cần lần xác thực trong `AUTH_SESSION_FRESH_AGE_SEC` (external: claim `auth_time`). */
export const RequireFreshSession = (): ClassDecorator & MethodDecorator =>
  SetMetadata(REQUIRE_FRESH_SESSION, true);
/** Spec SP3 §5.2, S2-R76: email đã xác thực, BẤT KỂ `AUTH_REQUIRE_EMAIL_VERIFICATION`. */
export const RequireVerifiedEmail = (): ClassDecorator & MethodDecorator =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL, true);
