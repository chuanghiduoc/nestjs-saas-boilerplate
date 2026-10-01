import { describe, expect, it } from 'vitest';
import {
  FEATURE_TRI_STATES,
  featureConfigProblems,
  resolveTenancyFeatures,
  type FeatureState,
} from '../../../../src/modules/tenancy/domain/tenancy-features.js';

const MODES = ['local', 'hybrid', 'external'] as const;
const URL_A = 'https://app.example.test/invitations/accept';
const URL_J = 'https://app.example.test/join';
const on: FeatureState = { enabled: true };

describe('resolveTenancyFeatures (spec SP3 §13 INT2-N-13, U17): 2 flags × 3 values × 3 modes', () => {
  for (const mode of MODES)
    for (const value of FEATURE_TRI_STATES)
      it(`emailInvitations=${value}, mode=${mode}`, () => {
        const withAll = resolveTenancyFeatures(
          {
            emailInvitations: value,
            invitationAcceptUrl: URL_A,
            inviteLinks: 'off',
            inviteLinkJoinUrl: undefined,
          },
          { mode, externalEmailClaim: 'email' },
        );
        expect(withAll.emailInvitations).toEqual(
          value === 'off' ? { enabled: false, reason: 'OFF' } : on,
        );
        const noUrl = resolveTenancyFeatures(
          {
            emailInvitations: value,
            invitationAcceptUrl: undefined,
            inviteLinks: 'off',
            inviteLinkJoinUrl: undefined,
          },
          { mode, externalEmailClaim: 'email' },
        );
        expect(noUrl.emailInvitations).toEqual({
          enabled: false,
          reason: value === 'off' ? 'OFF' : 'MISSING_ACCEPT_URL',
        });
        const noClaim = resolveTenancyFeatures(
          {
            emailInvitations: value,
            invitationAcceptUrl: URL_A,
            inviteLinks: 'off',
            inviteLinkJoinUrl: undefined,
          },
          { mode, externalEmailClaim: undefined },
        );
        expect(noClaim.emailInvitations).toEqual(
          value === 'off'
            ? { enabled: false, reason: 'OFF' }
            : mode === 'external'
              ? { enabled: false, reason: 'MISSING_EMAIL_CLAIM' }
              : on,
        );
      });
  for (const mode of MODES)
    for (const value of FEATURE_TRI_STATES)
      it(`inviteLinks=${value}, mode=${mode} (links need no email claim)`, () => {
        const states = resolveTenancyFeatures(
          {
            emailInvitations: 'off',
            invitationAcceptUrl: undefined,
            inviteLinks: value,
            inviteLinkJoinUrl: URL_J,
          },
          { mode, externalEmailClaim: undefined },
        );
        expect(states.inviteLinks).toEqual(
          value === 'off' ? { enabled: false, reason: 'OFF' } : on,
        );
        const noUrl = resolveTenancyFeatures(
          {
            emailInvitations: 'off',
            invitationAcceptUrl: undefined,
            inviteLinks: value,
            inviteLinkJoinUrl: undefined,
          },
          { mode, externalEmailClaim: undefined },
        );
        expect(noUrl.inviteLinks).toEqual({
          enabled: false,
          reason: value === 'off' ? 'OFF' : 'MISSING_JOIN_URL',
        });
      });
  it('featureConfigProblems: only "on" with a missing condition is an error; "auto" disables quietly', () => {
    const t = {
      emailInvitations: 'on',
      invitationAcceptUrl: undefined,
      inviteLinks: 'auto',
      inviteLinkJoinUrl: undefined,
    } as const;
    const states = resolveTenancyFeatures(t, {
      mode: 'local',
      externalEmailClaim: undefined,
    });
    expect(featureConfigProblems(t, states)).toEqual([
      'TENANCY_EMAIL_INVITATIONS=on needs TENANCY_INVITATION_ACCEPT_URL',
    ]);
    const ext = {
      emailInvitations: 'on',
      invitationAcceptUrl: URL_A,
      inviteLinks: 'on',
      inviteLinkJoinUrl: undefined,
    } as const;
    expect(
      featureConfigProblems(
        ext,
        resolveTenancyFeatures(ext, {
          mode: 'external',
          externalEmailClaim: undefined,
        }),
      ),
    ).toEqual([
      'TENANCY_EMAIL_INVITATIONS=on needs AUTH_EXTERNAL_EMAIL_CLAIM when AUTH_MODE=external',
      'TENANCY_INVITE_LINKS=on needs TENANCY_INVITE_LINK_JOIN_URL',
    ]);
  });
});
