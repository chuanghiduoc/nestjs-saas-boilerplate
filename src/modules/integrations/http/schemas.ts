import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  cursorPageQuery,
  cursorPageSchema,
  mergePatchSchema,
  offsetPageQuery,
  offsetPageSchema,
} from '../../../core/http/index.js';
import {
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  WEBHOOK_EVENT_TYPES_MAX,
  WEBHOOK_EVENT_TYPE_PATTERN,
  WEBHOOK_URL_MAX_LENGTH,
  WEBHOOK_URL_MIN_LENGTH,
  TIMESTAMPTZ_MIN_YEAR,
} from '../constants.js';
import { DELIVERY_STATUSES, LAST_ERRORS } from '../domain/webhook-delivery.js';
import {
  DISABLED_REASONS,
  ENDPOINT_STATUSES,
} from '../domain/webhook-endpoint.js';
import type { DeliveryView } from '../ports/delivery-repository.js';
import type { EndpointRow } from '../ports/endpoint-repository.js';

const iso = z.iso.datetime();
const url = z.string().min(WEBHOOK_URL_MIN_LENGTH).max(WEBHOOK_URL_MAX_LENGTH);
// Cùng luật với `webhook_endpoints_description_ck` (`btrim`, 1–500).
const description = z
  .string()
  .trim()
  .min(1)
  .max(WEBHOOK_DESCRIPTION_MAX_LENGTH);
/**
 * M7: trần cứng có tên, không đọc config lúc import — `openapi.json` (`maxItems`) giống nhau ở mọi máy export và `oasdiff`
 * không thấy thay đổi giả khi env khác. Trần thấp hơn của người vận hành do `EndpointService.knownTypes` kiểm lúc chạy.
 * Không dùng cách `paginationConfig` (đọc config lúc dựng schema): hợp đồng công khai không được phụ thuộc env.
 */
const eventTypes = z
  .array(z.string().regex(WEBHOOK_EVENT_TYPE_PATTERN))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES_MAX);

export const CreateEndpointBody = z
  .object({ url, description: description.optional(), eventTypes })
  .strict();
export const EndpointListPage = offsetPageQuery({
  sortable: ['createdAt'] as const,
});

export const WebhookEndpointResponse = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  status: z.enum(ENDPOINT_STATUSES),
  disabledReason: z.enum(DISABLED_REASONS).nullable(),
  failingSince: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const CreatedWebhookEndpointResponse = WebhookEndpointResponse.extend({
  secret: z.string(),
});
export const WebhookEndpointPage = offsetPageSchema(WebhookEndpointResponse);
export const endpointOf = (
  r: EndpointRow,
): z.infer<typeof WebhookEndpointResponse> => ({
  id: r.publicId,
  url: r.url,
  description: r.description,
  eventTypes: r.eventTypes,
  status: r.status,
  disabledReason: r.disabledReason,
  failingSince: r.failingSince?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
export const EventTypeListResponse = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      version: z.number().int(),
      schema: z.record(z.string(), z.unknown()),
    }),
  ),
});

const PublicId = z.uuid();
/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
export const publicIdOrNotFound = (raw: string): string => {
  const r = PublicId.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};

/** Route thường (R-X34): không đổi đích. Strict (`mergePatchSchema` dựng `z.strictObject`): `url`/`eventTypes` ở đây → 422. */
export const PatchEndpointBody = mergePatchSchema(
  z.object({
    description: description.nullable(),
    status: z.enum(ENDPOINT_STATUSES),
  }),
);
/** `PATCH …/destination` (R-X34): đổi nơi dữ liệu của org được gửi tới, cùng bộ guard với tạo endpoint. */
export const PatchEndpointDestinationBody = mergePatchSchema(
  z.object({ url, eventTypes }),
);
export const RotatedSecretResponse = z.object({
  secret: z.string(),
  previousExpiresAt: iso.nullable(),
});

export const DeliveryListQuery = cursorPageQuery().extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
});
export const WebhookDeliveryResponse = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  eventType: z.string(),
  eventId: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  /** Số lần claim (kể cả lần bị huỷ vì endpoint không còn hoạt động). */
  attempts: z.number().int(),
  nextAttemptAt: iso.nullable(),
  lastAttemptAt: iso.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.enum(LAST_ERRORS).nullable(),
  completedAt: iso.nullable(),
  createdAt: iso,
});
export const WebhookDeliveryPage = cursorPageSchema(WebhookDeliveryResponse);
export const deliveryOf = (
  v: DeliveryView,
): z.infer<typeof WebhookDeliveryResponse> => ({
  id: v.publicId,
  endpointId: v.endpointPublicId,
  eventType: v.eventType,
  eventId: v.eventId,
  status: v.status,
  attempts: v.attemptsTotal,
  nextAttemptAt: v.nextAttemptAt?.toISOString() ?? null,
  lastAttemptAt: v.lastAttemptAt?.toISOString() ?? null,
  lastStatusCode: v.lastStatusCode,
  lastError: v.lastError,
  completedAt: v.completedAt?.toISOString() ?? null,
  createdAt: v.createdAt.toISOString(),
});
export const RecoverBody = z
  .object({
    since: z.iso
      .datetime({ offset: true })
      // m-2: năm 0000 qua được regex ISO nhưng Postgres từ chối (22008 → 500).
      .refine(
        (s) => new Date(s).getUTCFullYear() >= TIMESTAMPTZ_MIN_YEAR,
        `must be in year ${TIMESTAMPTZ_MIN_YEAR} or later`,
      )
      .transform((s) => new Date(s)),
  })
  .strict();
export const RecoverResponse = z.object({
  requeued: z.number().int(),
  hasMore: z.boolean(),
});
