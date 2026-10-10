/** Hằng định dạng (spec §6.5 `webhook_messages_body_ck`): body lớn hơn là lỗi thiết kế event, không gửi. */
export const WEBHOOK_BODY_MAX_BYTES = 262_144;
/** Message của `POST …/test` (spec §8.3 "Gửi thử"); `webhook_messages_event_type_ck` cho phép riêng giá trị này. */
export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';
export const WEBHOOK_TEST_EVENT_VERSION = 1;

export type WebhookPayload = {
  type: string;
  version: number;
  timestamp: string;
  data: unknown;
};
export type BuiltBody =
  { kind: 'OK'; body: string } | { kind: 'TOO_LARGE'; bytes: number };

/** Tuần tự hoá MỘT lần (spec §8.3): chính chuỗi này được lưu và ký nguyên văn ở mọi lần gửi. */
export function buildWebhookBody(p: WebhookPayload): BuiltBody {
  const body = JSON.stringify({
    type: p.type,
    version: p.version,
    timestamp: p.timestamp,
    data: p.data,
  });
  const bytes = Buffer.byteLength(body, 'utf8');
  return bytes > WEBHOOK_BODY_MAX_BYTES
    ? { kind: 'TOO_LARGE', bytes }
    : { kind: 'OK', body };
}
