import { v5 } from 'uuid';
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

/** `v5('nestjs-saas-boilerplate/identity-events', v5.URL)` (A.1). Hằng số: đổi là mất dedupe với event cũ. */
export const IDENTITY_EVENT_NAMESPACE = '87857401-f233-5789-839c-2dc5fb919229';

/** Payload không có email (PII); subscriber đọc thêm qua IdentityDirectory nếu cần. */
export const UserRegisteredEvent = defineEvent({
  type: 'identity.user.registered',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ userId: z.uuid() }),
});

/** Id xác định trước (D10): after-hook và cron đối soát ghi cùng id, outbox + inbox chặn trùng. Ngoại lệ của "event id là v7" (ADR 0009). */
export const registeredEventId = (userId: string): string =>
  v5(`${UserRegisteredEvent.type}:${userId}`, IDENTITY_EVENT_NAMESPACE);
