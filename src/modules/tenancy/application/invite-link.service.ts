import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import {
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, userActor } from '../../../core/events/index.js';
import {
  newAcquisitionToken,
  tokenHashHex,
  tokenUrl,
} from '../domain/acquisition-token.js';
import { roleLabelOf } from '../domain/display-text.js';
import {
  inviteLinkStatusOf,
  type InviteLinkStatus,
} from '../domain/invite-link.js';
import { TenancyErrors } from '../errors.js';
import { InviteLinkCreatedEvent, InviteLinkRevokedEvent } from '../events.js';
import {
  InviteLinkRepository,
  type InviteLinkRow,
} from '../ports/invite-link-repository.js';
import type { MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { GrantorRecheck } from './grantor-recheck.js';
import type { TokenPreview } from './invitation.service.js';
import { InviteRole, actorOfMember } from './invite-role.js';
import { MemberAdmission } from './member-admission.js';
import { MemberService, type MemberView } from './member.service.js';
import { SubjectResolver } from './subject-resolver.js';
import { TenancyFeatures } from './tenancy-features.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { lockAdmittedUser } from './tenancy-user-lock.js';

type JoinOutcome =
  | { kind: 'JOINED'; member: MemberRow }
  | { kind: 'NOT_FOUND' }
  | { kind: 'INVALIDATED' };
const INVITATIONS_WRITE = 'invitations.write';
const ALREADY_MEMBER_CONSTRAINT = 'org_members_org_user_uq';
const MS_PER_SEC = 1000;
const notFound = () =>
  new AppError(TenancyErrors.INVITE_LINK_NOT_FOUND, { expected: true });
/** Link chưa thu hồi luôn có role (`org_invite_links_active_role_ck`). */
function activeRole(l: InviteLinkRow): { id: string; publicId: string } {
  if (l.roleId === null || l.rolePublicId === null)
    throw new Error(
      'an unrevoked invite link without a role (org_invite_links_active_role_ck)',
    );
  return { id: l.roleId, publicId: l.rolePublicId };
}

/**
 * Invite link dùng chung (spec SP3 §9.2, §8.4 đường c). Cùng khung với `InvitationService`: route cầm token tra hàm definer
 * rồi vào OrgScope; thứ tự khoá org → tenancy_users → link → member `FOR SHARE`; lượt dùng tăng bằng câu điều kiện atomic
 * (T-5, T-29) và rollback cùng membership khi `409 already_member`.
 * Extension point (S3-Q4 C): verified-domain auto-join — spec §19; domain join dùng lại `MemberAdmission` với nguồn `DOMAIN`.
 */
@Injectable()
export class InviteLinkService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly links: InviteLinkRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly inviteRole: InviteRole,
    private readonly grantor: GrantorRecheck,
    private readonly admission: MemberAdmission,
    private readonly memberViews: MemberService,
    private readonly events: EventPublisher,
    private readonly features: TenancyFeatures,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async list(q: { page: number; pageSize: number; cap: number }): Promise<{
    rows: (InviteLinkRow & { status: InviteLinkStatus })[];
    total: number;
  }> {
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.links.list({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.links.countUpTo(q.cap),
    ]);
    return {
      rows: rows.map((l) => ({ ...l, status: inviteLinkStatusOf(l, now) })),
      total,
    };
  }

  /** Không `@Idempotent()` ở route (S3-A8): retry tạo thêm một link thu hồi được, secret không vào Redis. */
  async create(input: {
    roleId: string;
    maxUses: number;
    expiresAt: Date;
  }): Promise<{ link: InviteLinkRow; url: string }> {
    this.features.require('inviteLinks');
    const joinBase = this.cfg.inviteLinkJoinUrl;
    if (joinBase === undefined)
      throw new Error(
        'invite links are enabled without TENANCY_INVITE_LINK_JOIN_URL',
      );
    if (input.maxUses > this.cfg.inviteLinkMaxUsesLimit)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [
          {
            path: 'maxUses',
            code: 'too_big',
            message: `maxUses must be at most ${this.cfg.inviteLinkMaxUsesLimit}`,
          },
        ],
      });
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([
        INVITATIONS_WRITE,
      ]);
      const role = await this.inviteRole.bindable(
        input.roleId,
        actorOfMember(actor, permissions),
      );
      // Giờ DB sau khoá (§3.15): `expiresAt` phải sau lúc này và không quá trần; `CHECK (expires_at > created_at)` không bao giờ bắn.
      const now = await this.orgs.clockNow();
      const ms = input.expiresAt.getTime() - now.getTime();
      if (ms <= 0 || ms > this.cfg.inviteLinkMaxTtlSec * MS_PER_SEC)
        throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
      if ((await this.links.countOpen()) >= this.cfg.maxActiveInviteLinksPerOrg)
        throw new AppError(TenancyErrors.INVITE_LINKS_LIMIT); // T-11
      const token = newAcquisitionToken();
      const link = await this.links.insert({
        roleId: role.id,
        createdByMemberId: actor.id,
        tokenHashHex: token.hashHex,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
      });
      await this.events.publish(InviteLinkCreatedEvent, {
        data: {
          inviteLinkId: link.publicId,
          roleId: role.publicId,
          maxUses: link.maxUses,
          expiresAt: link.expiresAt.toISOString(),
        },
        aggregate: {
          type: 'invite_link',
          id: link.publicId,
          version: link.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return { link, url: tokenUrl(joinBase, token.token) };
    });
  }

  /** `revoked_at = clock_timestamp()` khi còn NULL + event `{ REVOKED }`; đã thu hồi → no-op (DELETE idempotent, spec §15 không có mã riêng). */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      await this.reauth.require([INVITATIONS_WRITE]);
      const link = await this.links.lockByPublicId(publicId);
      if (!link) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
      const done = await this.links.revoke(link.id);
      if (!done) return;
      await this.events.publish(InviteLinkRevokedEvent, {
        data: { inviteLinkId: done.publicId, reason: 'REVOKED' },
        aggregate: {
          type: 'invite_link',
          id: done.publicId,
          version: done.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
    });
  }

  /** Spec §9.2 "Xem trước": `404 invite_link_not_found` cho mọi trạng thái khác ACTIVE. */
  async preview(token: string): Promise<TokenPreview> {
    const match = await this.links.findByTokenHash(tokenHashHex(token));
    if (!match) throw notFound();
    const view = await this.scope.run(match.orgId, () =>
      this.uow.run(async (): Promise<TokenPreview | undefined> => {
        const org = await this.orgs.readCurrent();
        if (!org || org.deletedAt) return undefined;
        const link = await this.links.findById(match.id);
        if (
          !link ||
          inviteLinkStatusOf(link, await this.orgs.clockNow()) !== 'ACTIVE'
        )
          return undefined;
        return {
          orgName: org.name,
          roleName: roleLabelOf({
            systemKey: link.roleSystemKey,
            name: link.roleName,
          }),
          expiresAt: link.expiresAt,
        };
      }),
    );
    if (!view) throw notFound();
    return view;
  }

  async join(token: string): Promise<{ orgId: string; member: MemberView }> {
    const { orgId, member } = await tenancySpan(
      'tenancy.invite_link.join',
      () => this.joinOnce(token),
      () => ({ 'tenancy.acquisition.result': 'accepted' }),
    );
    return {
      orgId,
      member: await this.scope.run(orgId, () =>
        this.memberViews.get(member.publicId),
      ),
    };
  }

  private async joinOnce(
    token: string,
  ): Promise<{ orgId: string; member: MemberRow }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const match = await this.links.findByTokenHash(tokenHashHex(token));
    if (!match) {
      this.metrics.inviteLinkJoins.add(1, { result: 'not_found' });
      throw notFound();
    }
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx, 'tenancy');
    let outcome: JoinOutcome;
    try {
      outcome = await this.scope.run(match.orgId, () =>
        this.uow.run(async (): Promise<JoinOutcome> => {
          const org = await this.orgs.lockCurrent();
          if (!org || org.deletedAt) return { kind: 'NOT_FOUND' }; // T-27
          const user = await lockAdmittedUser(this.users, subject);
          const link = await this.links.lockById(match.id);
          if (
            !link ||
            inviteLinkStatusOf(link, await this.orgs.clockNow()) !== 'ACTIVE'
          )
            return { kind: 'NOT_FOUND' };
          const ref = activeRole(link);
          const check = await this.grantor.check(link.createdByMemberId, {
            id: ref.id,
            systemKey: link.roleSystemKey,
          });
          if (!check.ok) {
            const done = await this.links.revoke(link.id);
            if (!done)
              throw new Error(
                'a locked unrevoked invite link was already revoked',
              );
            await this.events.publish(InviteLinkRevokedEvent, {
              data: { inviteLinkId: done.publicId, reason: 'INVALIDATED' },
              aggregate: {
                type: 'invite_link',
                id: done.publicId,
                version: done.version,
              },
              actor,
            });
            return { kind: 'INVALIDATED' };
          }
          // T-5, T-29: câu điều kiện với `clock_timestamp()`; 0 dòng (hết lượt/hết hạn khi đang chờ khoá) → 404.
          if (!(await this.links.consumeUse(link.id)))
            return { kind: 'NOT_FOUND' };
          const role = await this.roles.findByPublicId(ref.publicId);
          if (!role)
            throw new Error(
              'the role of an unrevoked invite link vanished under the org lock',
            );
          const member = await this.admission.admit({
            user,
            role,
            actor,
            admission: { source: 'INVITE_LINK', inviteLinkId: link.publicId },
          });
          return { kind: 'JOINED', member };
        }),
      );
    } catch (err) {
      if (pgFields(err)?.constraint === ALREADY_MEMBER_CONSTRAINT)
        this.metrics.inviteLinkJoins.add(1, { result: 'already_member' });
      // Chế độ single-org (`MemberAdmission`): user đã ở org khác.
      else if (
        err instanceof AppError &&
        err.error === TenancyErrors.ALREADY_IN_AN_ORG
      )
        this.metrics.inviteLinkJoins.add(1, { result: 'already_in_org' });
      // Spec SP4 §9.6: org đầy ghế (`MemberAdmission`, port `MemberSeatLimit`).
      else if (
        err instanceof AppError &&
        err.error === CoreErrors.QUOTA_EXCEEDED
      )
        this.metrics.inviteLinkJoins.add(1, { result: 'seat_limit' });
      throw err;
    }
    switch (outcome.kind) {
      case 'JOINED':
        this.metrics.inviteLinkJoins.add(1, { result: 'accepted' });
        return { orgId: match.orgId, member: outcome.member };
      case 'NOT_FOUND':
        this.metrics.inviteLinkJoins.add(1, { result: 'not_found' });
        throw notFound();
      case 'INVALIDATED':
        this.metrics.inviteLinkJoins.add(1, { result: 'invalidated' });
        throw new AppError(TenancyErrors.INVITE_LINK_INVALIDATED);
      default: {
        const unknown: never = outcome;
        throw new Error(`unknown join outcome ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt)
      throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
  }
}
