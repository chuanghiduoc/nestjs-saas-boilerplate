/** Máy trạng thái của một delivery (spec SP6 §7.2). DB ép cùng tập bằng `webhook_deliveries_status_ck`. */
export const DELIVERY_STATUSES = [
  'PENDING',
  'SENDING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'EXHAUSTED',
  'CANCELLED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const TERMINAL_DELIVERY_STATUSES = [
  'SUCCEEDED',
  'EXHAUSTED',
  'CANCELLED',
] as const satisfies readonly DeliveryStatus[];
/** Cùng tập, cùng thứ tự với `webhook_deliveries_last_error_ck` (`constants-vs-migration.spec.ts`). */
export const LAST_ERRORS = [
  'TIMEOUT',
  'NETWORK',
  'SERVER_ERROR',
  'CLIENT_ERROR',
  'REDIRECT',
  'RATE_LIMITED',
  'SSRF_BLOCKED',
  'TOO_LARGE',
  'BULKHEAD_FULL',
  'CIRCUIT_OPEN',
  'LEASE_EXPIRED',
  'SECRET_UNAVAILABLE',
  'ENDPOINT_UNAVAILABLE',
] as const;
export type LastError = (typeof LAST_ERRORS)[number];
/** `ENDPOINT_UNAVAILABLE` là nhánh `CANCELLED` lúc claim, không phải kết quả của một lần gửi. */
export type AttemptError = Exclude<LastError, 'ENDPOINT_UNAVAILABLE'>;
export const ATTEMPT_ERRORS: readonly AttemptError[] = LAST_ERRORS.filter(
  (e): e is AttemptError => e !== 'ENDPOINT_UNAVAILABLE',
);
export type Blame = 'ENDPOINT' | 'LOCAL';

/**
 * S6-A49: lỗi của endpoint tiêu một bước lịch và có thể tự tắt endpoint; lỗi của ta (bulkhead, breaker, worker chết, secret
 * không giải mã được) không chạm `failing_since` và không tiêu lịch, nhưng có đếm (R-X35: lần thứ
 * `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED`). `TIMEOUT` là của endpoint: thứ tự policy bulkhead → breaker → timeout
 * (`core/resilience/policies.ts`), thời gian chờ trong hàng bulkhead không tính vào timeout.
 */
export function classifyAttempt(error: AttemptError): Blame {
  switch (error) {
    case 'TIMEOUT':
    case 'NETWORK':
    case 'SERVER_ERROR':
    case 'CLIENT_ERROR':
    case 'REDIRECT':
    case 'RATE_LIMITED':
    case 'SSRF_BLOCKED':
    case 'TOO_LARGE':
      return 'ENDPOINT';
    case 'BULKHEAD_FULL':
    case 'CIRCUIT_OPEN':
    case 'LEASE_EXPIRED':
    case 'SECRET_UNAVAILABLE':
      return 'LOCAL';
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled attempt error ${String(unreachable)}`);
    }
  }
}

/**
 * R-X35: còn được hẹn lại sau lỗi của ta này không. `localFailuresBefore` là `local_failures` lúc claim (trước lỗi này);
 * lỗi thứ `max` → `false` (`EXHAUSTED`, phát lại được). Không giới hạn thì một khoá `FieldCipher` bị retire sai hay một
 * worker chết lặp lại sẽ giữ delivery xoay vòng mãi.
 */
export function localRetryLeft(
  localFailuresBefore: number,
  max: number,
): boolean {
  if (
    !Number.isInteger(localFailuresBefore) ||
    localFailuresBefore < 0 ||
    !Number.isInteger(max) ||
    max < 1
  )
    throw new Error(
      `localRetryLeft needs a non-negative integer count and a positive integer max, got (${localFailuresBefore}, ${max})`,
    );
  return localFailuresBefore + 1 < max;
}

export type DeliveryEvent =
  | { kind: 'CLAIM'; endpointAvailable: boolean }
  /** Không claim (kill switch, hoặc endpoint đã đủ in-flight — R-X35): chỉ dời `next_attempt_at`, không đếm gì. */
  | { kind: 'DEFER' }
  | { kind: 'DELIVERED' }
  /** `retryLeft`: ENDPOINT = còn bước lịch (`scheduledDelaySec`); LOCAL = `localRetryLeft`. */
  | { kind: 'FAILED'; blame: Blame; retryLeft: boolean }
  | { kind: 'REQUEUE' };
/**
 * `attemptsTotal: INCREMENT` ở MỌI claim (kể cả nhánh `CANCELLED`): jobId `webhook-<id>-a<n>` bị tiêu đúng khi
 * `attempts_total` thành n, nên mọi lần enqueue sau dùng `a<attempts_total + 1>` chưa từng có trong Redis. `cycleBase:
 * INCREMENT` (lỗi của ta) giữ nguyên số bước lịch đã tiêu. `localFailures: INCREMENT` ở mọi lỗi của ta, `RESET` khi phát lại.
 */
export type DeliveryEffect = {
  to: DeliveryStatus;
  attemptsTotal: 'INCREMENT' | 'KEEP';
  cycleBase: 'KEEP' | 'INCREMENT' | 'RESET_TO_ATTEMPTS';
  localFailures: 'KEEP' | 'INCREMENT' | 'RESET';
};
export type DeliveryTransition =
  { ok: true; effect: DeliveryEffect } | { ok: false };

const REFUSED: DeliveryTransition = { ok: false };
const to = (
  s: DeliveryStatus,
  attemptsTotal: DeliveryEffect['attemptsTotal'],
  cycleBase: DeliveryEffect['cycleBase'],
  localFailures: DeliveryEffect['localFailures'] = 'KEEP',
): DeliveryTransition => ({
  ok: true,
  effect: { to: s, attemptsTotal, cycleBase, localFailures },
});

export function isTerminalDelivery(status: DeliveryStatus): boolean {
  switch (status) {
    case 'SUCCEEDED':
    case 'EXHAUSTED':
    case 'CANCELLED':
      return true;
    case 'PENDING':
    case 'SENDING':
    case 'RETRY_SCHEDULED':
      return false;
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled delivery status ${String(unreachable)}`);
    }
  }
}
const isClaimable = (s: DeliveryStatus): boolean =>
  s === 'PENDING' || s === 'RETRY_SCHEDULED';

/** Nguồn sự thật của bảng chuyển; repository viết đúng các CAS này (mỗi CAS có `WHERE status IN (<nguồn>)`). */
export function transitionDelivery(
  from: DeliveryStatus,
  e: DeliveryEvent,
): DeliveryTransition {
  switch (e.kind) {
    case 'CLAIM':
      if (!isClaimable(from)) return REFUSED;
      return to(
        e.endpointAvailable ? 'SENDING' : 'CANCELLED',
        'INCREMENT',
        'KEEP',
      );
    case 'DEFER':
      return isClaimable(from) ? to(from, 'KEEP', 'KEEP') : REFUSED;
    case 'DELIVERED':
      return from === 'SENDING' ? to('SUCCEEDED', 'KEEP', 'KEEP') : REFUSED;
    case 'FAILED':
      if (from !== 'SENDING') return REFUSED;
      if (e.blame === 'LOCAL')
        return to(
          e.retryLeft ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
          'KEEP',
          'INCREMENT',
          'INCREMENT',
        );
      return to(e.retryLeft ? 'RETRY_SCHEDULED' : 'EXHAUSTED', 'KEEP', 'KEEP');
    case 'REQUEUE':
      return isTerminalDelivery(from)
        ? to('PENDING', 'KEEP', 'RESET_TO_ATTEMPTS', 'RESET')
        : REFUSED;
    default: {
      const unreachable: never = e;
      throw new Error(
        `Unhandled delivery event ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
