/**
 * Trạng thái hiệu lực của hai cờ tri-state của 3C (spec SP3 §13, INT2-N-13). Hàm thuần dùng chung cho luật config (boot
 * fail khi `on` thiếu điều kiện) và provider runtime (log INFO lý do khi `auto` tắt): không có hai định nghĩa lệch nhau.
 * 3D thêm cờ support grant vào cùng kiểu.
 */
export const FEATURE_TRI_STATES = ['auto', 'on', 'off'] as const;
export type FeatureTriState = (typeof FEATURE_TRI_STATES)[number];
export type FeatureDisabledReason =
  | 'OFF'
  | 'MISSING_ACCEPT_URL'
  | 'MISSING_JOIN_URL'
  | 'MISSING_EMAIL_CLAIM'
  | 'EXTERNAL_MODE';
export type FeatureState =
  { enabled: true } | { enabled: false; reason: FeatureDisabledReason };
export type TenancyFeatureStates = {
  emailInvitations: FeatureState;
  inviteLinks: FeatureState;
  /** 3D (spec §11, §13): support grant cần session Better Auth và factor 2FA của nó; `external` → tắt. */
  supportGrants: FeatureState;
};
export type TenancyFeatureInput = {
  emailInvitations: FeatureTriState;
  invitationAcceptUrl: string | undefined;
  inviteLinks: FeatureTriState;
  inviteLinkJoinUrl: string | undefined;
  supportGrants: FeatureTriState;
};
export type IdentityFeatureInput = {
  mode: string;
  externalEmailClaim: string | undefined;
};

const ENABLED: FeatureState = { enabled: true };
const disabled = (reason: FeatureDisabledReason): FeatureState => ({
  enabled: false,
  reason,
});

export function resolveTenancyFeatures(
  t: TenancyFeatureInput,
  id: IdentityFeatureInput,
): TenancyFeatureStates {
  const emailInvitations =
    t.emailInvitations === 'off'
      ? disabled('OFF')
      : !t.invitationAcceptUrl
        ? disabled('MISSING_ACCEPT_URL')
        : id.mode === 'external' && !id.externalEmailClaim
          ? disabled('MISSING_EMAIL_CLAIM')
          : ENABLED;
  const inviteLinks =
    t.inviteLinks === 'off'
      ? disabled('OFF')
      : !t.inviteLinkJoinUrl
        ? disabled('MISSING_JOIN_URL')
        : ENABLED;
  const supportGrants =
    t.supportGrants === 'off'
      ? disabled('OFF')
      : id.mode === 'external'
        ? disabled('EXTERNAL_MODE')
        : ENABLED;
  return { emailInvitations, inviteLinks, supportGrants };
}

function need(reason: FeatureDisabledReason): string {
  switch (reason) {
    case 'MISSING_ACCEPT_URL':
      return 'TENANCY_INVITATION_ACCEPT_URL';
    case 'MISSING_JOIN_URL':
      return 'TENANCY_INVITE_LINK_JOIN_URL';
    case 'MISSING_EMAIL_CLAIM':
      return 'AUTH_EXTERNAL_EMAIL_CLAIM when AUTH_MODE=external';
    case 'EXTERNAL_MODE':
      return 'AUTH_MODE=local or hybrid (support grants rely on Better Auth sessions and their second factor)';
    case 'OFF':
      throw new Error('an "on" flag cannot resolve to OFF');
    default: {
      const unknown: never = reason;
      throw new Error(`unknown feature reason ${String(unknown)}`);
    }
  }
}

/** Cờ `on` mà điều kiện thiếu là lỗi cấu hình (không khởi động); `auto` tắt êm và provider log lý do. */
export function featureConfigProblems(
  t: TenancyFeatureInput,
  s: TenancyFeatureStates,
): string[] {
  const out: string[] = [];
  if (t.emailInvitations === 'on' && !s.emailInvitations.enabled)
    out.push(
      `TENANCY_EMAIL_INVITATIONS=on needs ${need(s.emailInvitations.reason)}`,
    );
  if (t.inviteLinks === 'on' && !s.inviteLinks.enabled)
    out.push(`TENANCY_INVITE_LINKS=on needs ${need(s.inviteLinks.reason)}`);
  if (t.supportGrants === 'on' && !s.supportGrants.enabled)
    out.push(`TENANCY_SUPPORT_GRANTS=on needs ${need(s.supportGrants.reason)}`);
  return out;
}
