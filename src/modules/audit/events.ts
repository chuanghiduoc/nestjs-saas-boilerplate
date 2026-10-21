import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

export const STAFF_ACCESS_AGGREGATE = 'staff_access';
export const STAFF_ACCESS_PARAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
export const STAFF_ACCESS_PARAM_VALUE_MAX = 256;
export const STAFF_ACCESS_PARAMS_MAX = 16;
export const STAFF_ACCESS_ROUTE_MAX = 512;
export const STAFF_ACCESS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export const STAFF_CREDENTIAL_KINDS = [
  'SESSION_COOKIE',
  'BEARER_SESSION',
  'EXTERNAL_COOKIE',
  'EXTERNAL_BEARER',
] as const;

/** Spec §8.4, §10 (S6-A51): mọi truy cập route `@PlatformStaffAction()` đã qua gate; ghi TRƯỚC handler. */
export const StaffAccessRecordedEvent = defineEvent({
  type: 'audit.staff_access.recorded',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    method: z.enum(STAFF_ACCESS_METHODS),
    route: z.string().min(1).max(STAFF_ACCESS_ROUTE_MAX),
    params: z
      .record(
        z.string().regex(STAFF_ACCESS_PARAM_KEY),
        z.string().max(STAFF_ACCESS_PARAM_VALUE_MAX),
      )
      .refine((p) => Object.keys(p).length <= STAFF_ACCESS_PARAMS_MAX, {
        message: `at most ${STAFF_ACCESS_PARAMS_MAX} path params`,
      }),
    credentialKind: z.enum(STAFF_CREDENTIAL_KINDS),
  }),
});
