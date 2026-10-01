import { z } from 'zod';
import {
  type ConfigOf,
  defineConfig,
  defineConfigRule,
  defineProductionRule,
} from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from './constants.js';
import {
  FEATURE_TRI_STATES,
  featureConfigProblems,
  resolveTenancyFeatures,
} from './domain/tenancy-features.js';

const MS_PER_SEC = 1000;
const SECONDS_PER_DAY = 86_400;
const MIN_GRACE_SEC = SECONDS_PER_DAY;
const MAX_GRACE_SEC = 365 * SECONDS_PER_DAY;
/** Spec SP3 §13: production giữ org xoá mềm ít nhất 7 ngày trước khi xoá cứng. */
const PRODUCTION_MIN_GRACE_SEC = 7 * SECONDS_PER_DAY;
const MAX_ORGS_PER_USER = 1000;
const SECONDS_PER_HOUR = 3600;
const MIN_TOKEN_TTL_SEC = SECONDS_PER_HOUR;
const MAX_INVITATION_TTL_SEC = 30 * SECONDS_PER_DAY;
const MAX_INVITE_LINK_TTL_SEC = 365 * SECONDS_PER_DAY;
const MAX_TRANSFER_TTL_SEC = 30 * SECONDS_PER_DAY;
const MAX_PENDING_INVITATIONS = 10_000;
const MAX_INVITE_LINK_USES = 100_000;
const MAX_ACTIVE_INVITE_LINKS = 1000;

export const TENANCY_MEMBERSHIP_MODES = ['multi', 'single'] as const;
export const TENANCY_ORG_CREATION_MODES = [
  'self_service',
  'platform_admin',
] as const;

const positiveInt = z.coerce.number().int().positive();
// rate-limiter-flexible đếm cửa sổ theo giây nguyên (quy ước `throttle.config.ts`, INT-M6).
const windowMs = positiveInt.multipleOf(MS_PER_SEC);
const cron = z
  .string()
  .min(1)
  .refine(isValidCron, 'must be a valid cron expression');
const timezone = z
  .string()
  .min(1)
  .refine(
    (tz) => normalizeTimezone(tz) !== undefined,
    'must be an IANA timezone name',
  );
/** URL frontend tuyệt đối (http/https), không query, không fragment: app nối `#token=` vào cuối (spec §13). */
const isFrontendUrl = (s: string): boolean => {
  if (!URL.canParse(s) || s.includes('?') || s.includes('#')) return false;
  const u = new URL(s);
  return u.protocol === 'https:' || u.protocol === 'http:';
};
const frontendUrl = z
  .string()
  .optional()
  .transform((s) => (s ? s : undefined))
  .refine(
    (s) => s === undefined || isFrontendUrl(s),
    'must be an absolute http(s) URL without query or fragment',
  );
const triState = z.enum(FEATURE_TRI_STATES);

export const tenancyConfig = defineConfig(
  'tenancy',
  {
    membershipMode: 'TENANCY_MEMBERSHIP_MODE',
    orgCreation: 'TENANCY_ORG_CREATION',
    maxOrgsCreatedPerUser: 'TENANCY_MAX_ORGS_CREATED_PER_USER',
    orgDeleteGraceSec: 'TENANCY_ORG_DELETE_GRACE_SEC',
    purgeCron: 'TENANCY_ORG_PURGE_CRON',
    purgeTz: 'TENANCY_ORG_PURGE_TZ',
    purgeBatchSize: 'TENANCY_ORG_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'TENANCY_ORG_PURGE_MAX_BATCHES',
    orgMissLimit: 'TENANCY_ORG_MISS_RATE_LIMIT',
    orgMissTtlMs: 'TENANCY_ORG_MISS_RATE_TTL_MS',
    emailInvitations: 'TENANCY_EMAIL_INVITATIONS',
    invitationAcceptUrl: 'TENANCY_INVITATION_ACCEPT_URL',
    invitationTtlSec: 'TENANCY_INVITATION_TTL_SEC',
    maxPendingInvitationsPerOrg: 'TENANCY_MAX_PENDING_INVITATIONS_PER_ORG',
    inviteLinks: 'TENANCY_INVITE_LINKS',
    inviteLinkJoinUrl: 'TENANCY_INVITE_LINK_JOIN_URL',
    inviteLinkMaxTtlSec: 'TENANCY_INVITE_LINK_MAX_TTL_SEC',
    inviteLinkMaxUsesLimit: 'TENANCY_INVITE_LINK_MAX_USES_LIMIT',
    maxActiveInviteLinksPerOrg: 'TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG',
    tokenPreviewLimit: 'TENANCY_TOKEN_PREVIEW_RATE_LIMIT',
    tokenPreviewTtlMs: 'TENANCY_TOKEN_PREVIEW_RATE_TTL_MS',
    ownershipTransferTtlSec: 'TENANCY_OWNERSHIP_TRANSFER_TTL_SEC',
  },
  z.object({
    membershipMode: z
      .enum(TENANCY_MEMBERSHIP_MODES)
      .default('multi')
      .describe(
        'multi: a user may belong to many organizations; single: at most one (applies to new joins only)',
      ),
    orgCreation: z
      .enum(TENANCY_ORG_CREATION_MODES)
      .default('self_service')
      .describe(
        'Who may create organizations: any verified user, or platform admins only',
      ),
    maxOrgsCreatedPerUser: positiveInt
      .max(MAX_ORGS_PER_USER)
      .default(5)
      .describe(
        'Organizations one user may have created (soft-deleted ones count until purged)',
      ),
    orgDeleteGraceSec: positiveInt
      .min(MIN_GRACE_SEC)
      .max(MAX_GRACE_SEC)
      .default(2_592_000)
      .describe(
        'Seconds a soft-deleted organization can be restored before it is purged (production: at least 604800)',
      ),
    purgeCron: cron.default('0 3 * * *').describe('Cron of tenancy.orgs.purge'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt
      .max(DEFINER_LIMIT_MAX)
      .default(50)
      .describe('Organizations enqueued per purge batch'),
    purgeMaxBatches: positiveInt
      .max(DEFINER_LIMIT_MAX)
      .default(10)
      .describe('Max purge batches per cron run'),
    orgMissLimit: positiveInt
      .default(30)
      .describe(
        'Real organization misses (404) per window per principal before it is blocked (429)',
      ),
    orgMissTtlMs: windowMs
      .default(60_000)
      .describe(
        'Organization miss window and block duration (ms, whole seconds)',
      ),
    emailInvitations: triState
      .default('auto')
      .describe(
        'auto: on when TENANCY_INVITATION_ACCEPT_URL is set (and AUTH_EXTERNAL_EMAIL_CLAIM in external mode); on: required; off',
      ),
    invitationAcceptUrl: frontendUrl.describe(
      'Frontend page that accepts an invitation; the app appends #token=<token> (production: https, on HTTP_CORS_ORIGINS)',
    ),
    invitationTtlSec: positiveInt
      .min(MIN_TOKEN_TTL_SEC)
      .max(MAX_INVITATION_TTL_SEC)
      .default(604_800)
      .describe('Seconds an email invitation stays valid'),
    maxPendingInvitationsPerOrg: positiveInt
      .max(MAX_PENDING_INVITATIONS)
      .default(100)
      .describe('Pending, unexpired invitations one organization may hold'),
    inviteLinks: triState
      .default('auto')
      .describe(
        'auto: on when TENANCY_INVITE_LINK_JOIN_URL is set; on: required; off',
      ),
    inviteLinkJoinUrl: frontendUrl.describe(
      'Frontend page that joins through an invite link; the app appends #token=<token> (production: https, on HTTP_CORS_ORIGINS)',
    ),
    inviteLinkMaxTtlSec: positiveInt
      .min(MIN_TOKEN_TTL_SEC)
      .max(MAX_INVITE_LINK_TTL_SEC)
      .default(2_592_000)
      .describe('Longest lifetime of an invite link'),
    inviteLinkMaxUsesLimit: positiveInt
      .max(MAX_INVITE_LINK_USES)
      .default(1000)
      .describe('Largest maxUses of an invite link'),
    maxActiveInviteLinksPerOrg: positiveInt
      .max(MAX_ACTIVE_INVITE_LINKS)
      .default(10)
      .describe(
        'Open (unrevoked, unexpired, not exhausted) invite links per organization',
      ),
    tokenPreviewLimit: positiveInt
      .default(20)
      .describe('Invitation/invite link previews per window per client IP'),
    tokenPreviewTtlMs: windowMs
      .default(60_000)
      .describe('Token preview window and block duration (ms, whole seconds)'),
    ownershipTransferTtlSec: positiveInt
      .min(MIN_TOKEN_TTL_SEC)
      .max(MAX_TRANSFER_TTL_SEC)
      .default(604_800)
      .describe('Seconds an ownership transfer request stays open'),
  }),
);
export type TenancyConfig = ConfigOf<typeof tenancyConfig>;

defineProductionRule('tenancy-org-delete-grace', (c) => {
  const grace = c.tenancy?.orgDeleteGraceSec;
  if (typeof grace !== 'number')
    return 'tenancy grace rule needs the tenancy namespace';
  return grace >= PRODUCTION_MIN_GRACE_SEC
    ? undefined
    : `TENANCY_ORG_DELETE_GRACE_SEC must be at least ${PRODUCTION_MIN_GRACE_SEC} in production`;
});
/** Cùng kiểu `throttle-pre-auth-not-looser` (S2-R53 N2): so cả số lượng lẫn cửa sổ. */
defineProductionRule('tenancy-org-miss-not-looser', (c) => {
  const t = c.throttle;
  const n = c.tenancy;
  if (
    typeof t?.limit !== 'number' ||
    typeof t.ttlMs !== 'number' ||
    typeof n?.orgMissLimit !== 'number' ||
    typeof n.orgMissTtlMs !== 'number'
  )
    return 'tenancy org-miss rule needs the throttle and tenancy namespaces';
  if (n.orgMissLimit > t.limit)
    return 'TENANCY_ORG_MISS_RATE_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production';
  if (n.orgMissTtlMs < t.ttlMs)
    return 'TENANCY_ORG_MISS_RATE_TTL_MS must be at least THROTTLE_DEFAULT_TTL_MS in production';
  return undefined;
});
/** Spec SP3 §13 "Luật mọi môi trường": cờ `on` thiếu điều kiện → không khởi động (qua CÙNG hàm của provider runtime). */
const FeatureRuleInput = z.object({
  tenancy: z.object({
    emailInvitations: triState,
    invitationAcceptUrl: z.string().optional(),
    inviteLinks: triState,
    inviteLinkJoinUrl: z.string().optional(),
  }),
  identity: z.object({
    mode: z.string(),
    externalEmailClaim: z.string().optional(),
  }),
});
defineConfigRule('tenancy-features-on', (c) => {
  const parsed = FeatureRuleInput.safeParse(c);
  if (!parsed.success)
    return 'tenancy features rule needs the tenancy and identity namespaces';
  const { tenancy, identity } = parsed.data;
  const t = {
    ...tenancy,
    invitationAcceptUrl: tenancy.invitationAcceptUrl,
    inviteLinkJoinUrl: tenancy.inviteLinkJoinUrl,
  };
  const problems = featureConfigProblems(
    t,
    resolveTenancyFeatures(t, {
      mode: identity.mode,
      externalEmailClaim: identity.externalEmailClaim,
    }),
  );
  return problems.length ? problems.join('; ') : undefined;
});
/** Spec SP3 §13 "Luật production": URL frontend (khi có) là https và thuộc HTTP_CORS_ORIGINS. */
defineProductionRule('tenancy-frontend-urls', (c) => {
  const origins = Array.isArray(c.http?.corsOrigins) ? c.http.corsOrigins : [];
  const urls: [string, unknown][] = [
    ['TENANCY_INVITATION_ACCEPT_URL', c.tenancy?.invitationAcceptUrl],
    ['TENANCY_INVITE_LINK_JOIN_URL', c.tenancy?.inviteLinkJoinUrl],
  ];
  for (const [name, value] of urls) {
    if (typeof value !== 'string') continue;
    const u = new URL(value);
    if (u.protocol !== 'https:') return `${name} must use https in production`;
    if (!origins.includes(u.origin))
      return `${name} must be on an origin listed in HTTP_CORS_ORIGINS`;
  }
  return undefined;
});
