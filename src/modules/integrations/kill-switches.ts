import { defineKillSwitch } from '../../core/flags/index.js';

/** Spec SP6 §1 (11): bật → không request ra ngoài; delivery giữ nguyên và chạy lại khi tắt. */
export const WebhookDeliveryKillSwitch = defineKillSwitch({
  key: 'integrations.webhook_delivery',
  description:
    'Stops outbound webhook requests; deliveries wait and resume when the switch is turned off',
});
