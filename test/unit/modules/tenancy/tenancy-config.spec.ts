import { describe, expect, it } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import {
  configRuleRegistry,
  productionRuleRegistry,
} from '../../../../src/core/config/config.registry.js';
import { tenancyConfig } from '../../../../src/modules/tenancy/tenancy.config.js';

const parse = (env: Record<string, unknown>) =>
  tenancyConfig.schema.safeParse(env);
const rule = (name: string) => {
  const r = productionRuleRegistry().find((x) => x.name === name);
  if (!r) throw new Error(`production rule ${name} is not registered`);
  return r.rule;
};

describe('tenancy config (spec SP3 §13, INT-I12)', () => {
  it('defaults boot with no env at all', () => {
    expect(parse({}).data).toEqual({
      membershipMode: 'multi',
      orgCreation: 'self_service',
      maxOrgsCreatedPerUser: 5,
      orgDeleteGraceSec: 2_592_000,
      purgeCron: '0 3 * * *',
      purgeTz: 'UTC',
      purgeBatchSize: 50,
      purgeMaxBatches: 10,
      orgMissLimit: 30,
      orgMissTtlMs: 60_000,
      emailInvitations: 'auto',
      invitationAcceptUrl: undefined,
      invitationTtlSec: 604_800,
      maxPendingInvitationsPerOrg: 100,
      inviteLinks: 'auto',
      inviteLinkJoinUrl: undefined,
      inviteLinkMaxTtlSec: 2_592_000,
      inviteLinkMaxUsesLimit: 1000,
      maxActiveInviteLinksPerOrg: 10,
      tokenPreviewLimit: 20,
      tokenPreviewTtlMs: 60_000,
      ownershipTransferTtlSec: 604_800,
      orgApiKeyMaxTtlSec: 31_536_000,
      maxActiveOrgApiKeysPerMember: 20,
      supportGrants: 'auto',
      supportGrantMaxTtlSec: 259_200,
      supportStepUpMaxAgeSec: 3_600,
    });
  });
  it('3D defaults and bounds (spec §13)', () => {
    const d = tenancyConfig.schema.parse({});
    expect([
      d.orgApiKeyMaxTtlSec,
      d.maxActiveOrgApiKeysPerMember,
      d.supportGrants,
      d.supportGrantMaxTtlSec,
      d.supportStepUpMaxAgeSec,
    ]).toEqual([31_536_000, 20, 'auto', 259_200, 3_600]);
    for (const bad of [
      { orgApiKeyMaxTtlSec: '86399' },
      { orgApiKeyMaxTtlSec: '63072001' },
      { maxActiveOrgApiKeysPerMember: '0' },
      { maxActiveOrgApiKeysPerMember: '1001' },
      { supportGrantMaxTtlSec: '899' },
      { supportGrantMaxTtlSec: '259201' },
      { supportStepUpMaxAgeSec: '299' },
      { supportStepUpMaxAgeSec: '86401' },
      { supportGrants: 'yes' },
    ])
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it.each([
    [{ membershipMode: 'solo' }],
    [{ orgCreation: 'anyone' }],
    [{ maxOrgsCreatedPerUser: '0' }],
    [{ maxOrgsCreatedPerUser: '1001' }],
    [{ orgDeleteGraceSec: '86399' }],
    [{ orgDeleteGraceSec: '31536001' }],
    [{ purgeCron: 'not a cron' }],
    [{ purgeTz: 'Mars/Olympus' }],
    [{ purgeBatchSize: '1001' }],
    [{ purgeMaxBatches: '0' }],
    [{ orgMissLimit: '0' }],
    [{ orgMissTtlMs: '1500' }],
    [{ emailInvitations: 'yes' }],
    [{ invitationAcceptUrl: 'app.example.test/accept' }],
    [{ invitationAcceptUrl: 'https://app.example.test/accept?x=1' }],
    [{ invitationAcceptUrl: 'https://app.example.test/accept#token=' }],
    [{ invitationAcceptUrl: 'ftp://app.example.test/accept' }],
    [{ invitationTtlSec: '3599' }],
    [{ invitationTtlSec: '2592001' }],
    [{ maxPendingInvitationsPerOrg: '10001' }],
    [{ inviteLinkMaxTtlSec: '31536001' }],
    [{ inviteLinkMaxUsesLimit: '100001' }],
    [{ maxActiveInviteLinksPerOrg: '1001' }],
    [{ tokenPreviewLimit: '0' }],
    [{ tokenPreviewTtlMs: '1500' }],
    [{ ownershipTransferTtlSec: '3599' }],
  ])('rejects %j', (env) => {
    expect(parse(env).success).toBe(false);
  });
  it('production: grace must be at least 7 days', () => {
    const r = rule('tenancy-org-delete-grace');
    expect(r({ tenancy: { orgDeleteGraceSec: 604_799 } })).toMatch(
      /TENANCY_ORG_DELETE_GRACE_SEC/,
    );
    expect(r({ tenancy: { orgDeleteGraceSec: 604_800 } })).toBeUndefined();
  });
  it('production: the org-miss limiter is never looser than the default throttler (count and window)', () => {
    const r = rule('tenancy-org-miss-not-looser');
    const throttle = { limit: 300, ttlMs: 60_000 };
    expect(
      r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } }),
    ).toBeUndefined();
    expect(
      r({ throttle, tenancy: { orgMissLimit: 301, orgMissTtlMs: 60_000 } }),
    ).toMatch(/TENANCY_ORG_MISS_RATE_LIMIT/);
    expect(
      r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 10_000 } }),
    ).toMatch(/TENANCY_ORG_MISS_RATE_TTL_MS/);
    expect(r({ tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } })).toMatch(
      /needs the throttle and tenancy namespaces/,
    );
  });
  it('every environment: an "on" feature missing its condition refuses to boot, "auto" does not', () => {
    const r = configRuleRegistry().find(
      (x) => x.name === 'tenancy-features-on',
    );
    if (!r)
      throw new Error('config rule tenancy-features-on is not registered');
    const tenancy = {
      emailInvitations: 'on',
      invitationAcceptUrl: undefined,
      inviteLinks: 'auto',
      inviteLinkJoinUrl: undefined,
      supportGrants: 'auto',
    };
    expect(
      r.rule({
        tenancy,
        identity: { mode: 'local', externalEmailClaim: undefined },
      }),
    ).toMatch(
      /TENANCY_EMAIL_INVITATIONS=on needs TENANCY_INVITATION_ACCEPT_URL/,
    );
    expect(
      r.rule({
        tenancy: { ...tenancy, emailInvitations: 'auto' },
        identity: { mode: 'local', externalEmailClaim: undefined },
      }),
    ).toBeUndefined();
    expect(
      r.rule({
        tenancy: { ...tenancy, invitationAcceptUrl: 'https://a.test/x' },
        identity: { mode: 'external', externalEmailClaim: undefined },
      }),
    ).toMatch(/AUTH_EXTERNAL_EMAIL_CLAIM/);
  });
  it('production: frontend URLs must be https and on an origin of HTTP_CORS_ORIGINS', () => {
    const r = rule('tenancy-frontend-urls');
    const http = { corsOrigins: ['https://app.example.test'] };
    expect(
      r({
        http,
        tenancy: {
          invitationAcceptUrl: 'https://app.example.test/accept',
          inviteLinkJoinUrl: 'https://app.example.test/join',
        },
      }),
    ).toBeUndefined();
    expect(
      r({
        http,
        tenancy: {
          invitationAcceptUrl: undefined,
          inviteLinkJoinUrl: undefined,
        },
      }),
    ).toBeUndefined();
    expect(
      r({
        http,
        tenancy: { invitationAcceptUrl: 'http://app.example.test/accept' },
      }),
    ).toMatch(/TENANCY_INVITATION_ACCEPT_URL must use https/);
    expect(
      r({
        http,
        tenancy: { inviteLinkJoinUrl: 'https://evil.example.test/join' },
      }),
    ).toMatch(
      /TENANCY_INVITE_LINK_JOIN_URL must be on an origin listed in HTTP_CORS_ORIGINS/,
    );
  });
});
