import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { TEMPLATE_KEYS } from './templates.js';

/** Lý do thư bị bỏ: 4 mã SMTP, cộng hai lý do không phải SMTP (không vào `last_error_code`). */
export const DELIVERY_FAILURE_CODES = [
  'SMTP_TRANSIENT',
  'SMTP_PERMANENT',
  'SMTP_TIMEOUT',
  'SMTP_CONNECTION',
  'RENDER_FAILED',
  'ATTEMPTS_EXHAUSTED',
] as const;
export type DeliveryFailureCode = (typeof DELIVERY_FAILURE_CODES)[number];

export const DeliveryFailedEvent = defineEvent({
  type: 'notifications.delivery.failed',
  version: 1,
  audit: false,
  webhook: false,
  schema: z.object({
    deliveryId: z.uuid(),
    template: z.enum(TEMPLATE_KEYS),
    errorCode: z.enum(DELIVERY_FAILURE_CODES),
  }),
});
