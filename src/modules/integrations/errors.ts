import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { defineErrorCodes } from '../../core/errors/index.js';

/** Mã do integrations sở hữu (spec SP6 §9.4, cột "Chủ" = integrations). */
export const IntegrationsErrors = defineErrorCodes({
  WEBHOOK_URL_NOT_ALLOWED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This webhook URL is not allowed',
  },
  WEBHOOK_EVENT_TYPE_UNKNOWN: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unknown webhook event type',
  },
  WEBHOOK_ENDPOINTS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Webhook endpoint limit reached',
  },
  WEBHOOK_ENDPOINT_DISABLED: {
    status: HttpStatus.CONFLICT,
    title: 'The webhook endpoint is not active',
  },
  WEBHOOK_DELIVERY_NOT_RETRYABLE: {
    status: HttpStatus.CONFLICT,
    title: 'The delivery is still pending or being sent',
  },
});

/** Catalog event type bị gỡ giữa lúc kiểm và lúc ghi đăng ký (race hẹp): cùng mã với kiểm ở service. */
defineConstraintErrors({
  webhook_endpoint_event_types_type_fk:
    IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
});
