import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { WEBHOOK_EVENT_TYPE_PATTERN } from './constants.js';
import { DISABLED_REASONS } from './domain/webhook-endpoint.js';

/**
 * Event của 6C (spec SP6 §10): `audit: true` (thao tác trên kênh xuất dữ liệu của org), `webhook: false` (không tự phát
 * webhook về chính webhook). Payload chỉ id công khai và host, không URL, không secret.
 */
const id = z.uuid();
const eventTypes = z.array(z.string().regex(WEBHOOK_EVENT_TYPE_PATTERN)).min(1);
export const EndpointCreatedEvent = defineEvent({
  type: 'integrations.endpoint.created',
  version: 1,
  schema: z.object({ endpointId: id, urlHost: z.string().min(1), eventTypes }),
  audit: true,
  webhook: false,
});
export const EndpointUpdatedEvent = defineEvent({
  type: 'integrations.endpoint.updated',
  version: 1,
  schema: z.object({
    endpointId: id,
    changed: z.array(z.enum(['url', 'description', 'eventTypes'])).min(1),
    urlHost: z.string().min(1).optional(),
    eventTypes: eventTypes.optional(),
  }),
  audit: true,
  webhook: false,
});
export const EndpointDeletedEvent = defineEvent({
  type: 'integrations.endpoint.deleted',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const EndpointEnabledEvent = defineEvent({
  type: 'integrations.endpoint.enabled',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const EndpointDisabledEvent = defineEvent({
  type: 'integrations.endpoint.disabled',
  version: 1,
  schema: z.object({ endpointId: id, reason: z.enum(DISABLED_REASONS) }),
  audit: true,
  webhook: false,
});
export const EndpointSecretRotatedEvent = defineEvent({
  type: 'integrations.endpoint.secret_rotated',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const DeliveryExhaustedEvent = defineEvent({
  type: 'integrations.delivery.exhausted',
  version: 1,
  schema: z.object({
    deliveryId: id,
    endpointId: id,
    eventType: z.string().min(1),
    eventId: id,
  }),
  audit: true,
  webhook: false,
});
