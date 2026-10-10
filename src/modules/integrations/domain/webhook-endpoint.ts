/** Máy trạng thái endpoint (spec SP6 §7.3). DB ép cặp `status`/`disabled_reason` bằng `webhook_endpoints_disabled_pair_ck`. */
export const ENDPOINT_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];
export const DISABLED_REASONS = ['MANUAL', 'AUTO_FAILING'] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];
export type EndpointState =
  { status: 'ACTIVE' } | { status: 'DISABLED'; reason: DisabledReason };
export type EndpointEvent =
  { kind: 'DISABLE' } | { kind: 'ENABLE' } | { kind: 'AUTO_DISABLE' };
export type EndpointTransition =
  { kind: 'CHANGED'; to: EndpointState } | { kind: 'UNCHANGED' };

const UNCHANGED: EndpointTransition = { kind: 'UNCHANGED' };

/** `PATCH status` lặp lại hoặc tự tắt trên endpoint đã tắt là không đổi gì (không event, không bump version). */
export function transitionEndpoint(
  from: EndpointState,
  e: EndpointEvent,
): EndpointTransition {
  switch (e.kind) {
    case 'DISABLE':
      return from.status === 'ACTIVE'
        ? { kind: 'CHANGED', to: { status: 'DISABLED', reason: 'MANUAL' } }
        : UNCHANGED;
    case 'AUTO_DISABLE':
      return from.status === 'ACTIVE'
        ? {
            kind: 'CHANGED',
            to: { status: 'DISABLED', reason: 'AUTO_FAILING' },
          }
        : UNCHANGED;
    case 'ENABLE':
      return from.status === 'DISABLED'
        ? { kind: 'CHANGED', to: { status: 'ACTIVE' } }
        : UNCHANGED;
    default: {
      const unreachable: never = e;
      throw new Error(
        `Unhandled endpoint event ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/** Chỉ host (spec §8.3 bước 3): path/query có thể chứa token của khách, không bao giờ vào event hay log. */
export const urlHost = (url: string): string => new URL(url).hostname;
