import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '../../errors/index.js';

export type QueueDashboardDecision =
  | { allowed: true }
  | { allowed: false; error: ErrorCode; headers?: Record<string, string> };

/**
 * Ai được xem dashboard (spec §5.12): core không biết identity nên chỉ định nghĩa cổng; identity cài đặt
 * (đa credential, API key bị từ chối, CSRF, platform admin). Chỉ gọi sau khi IP đã qua allowlist.
 */
export abstract class QueueDashboardAuthorizer {
  abstract authorize(req: IncomingMessage): Promise<QueueDashboardDecision>;
}
