import { Inject, Injectable, Optional } from '@nestjs/common';
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
  AuthFacts,
  IdentityDirectory,
  IdentityErrors,
  identityConfig,
} from '../../identity/index.js';
import {
  DISPLAY_NAME_MAX,
  EmailNotifications,
} from '../../notifications/index.js';
import {
  newAcquisitionToken,
  tokenHashHex,
  tokenUrl,
} from '../domain/acquisition-token.js';
import { oneLine, roleLabelOf } from '../domain/display-text.js';
import { isLapsed } from '../domain/expiry.js';
import {
  effectiveInvitationStatus,
  type InvitationStatus,
} from '../domain/invitation.js';
import { TenancyErrors } from '../errors.js';
import {
  InvitationAcceptedEvent,
  InvitationCreatedEvent,
  InvitationInvalidatedEvent,
  InvitationRevokedEvent,
} from '../events.js';
import {
  InvitationRepository,
  type InvitationRow,
} from '../ports/invitation-repository.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { GrantorRecheck } from './grantor-recheck.js';
import { InviteRole, actorOfMember } from './invite-role.js';
import { MemberAdmission } from './member-admission.js';
import { MemberService, type MemberView } from './member.service.js';
import { SubjectResolver } from './subject-resolver.js';
import { TenancyFeatures } from './tenancy-features.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { lockAdmittedUser } from './tenancy-user-lock.js';

export type TokenPreview = {
  orgName: string;
  roleName: string;
  expiresAt: Date;
};
type AcceptOutcome =
  | { kind: 'ACCEPTED'; member: MemberRow }
  | { kind: 'NOT_FOUND' }
  | { kind: 'INVALIDATED' };
const INVITATIONS_WRITE = 'invitations.write';
const ALREADY_MEMBER_CONSTRAINT = 'org_members_org_user_uq';

/** PENDING luôn có role (`org_invitations_pending_role_ck`); thiếu là lỗi lập trình, không phải 404. */
function pendingRole(i: InvitationRow): { id: string; publicId: string } {
  if (i.roleId === null || i.rolePublicId === null)
    throw new Error(
      'a PENDING invitation without a role (org_invitations_pending_role_ck)',
    );
  return { id: i.roleId, publicId: i.rolePublicId };
}
const notFound = () =>
  new AppError(TenancyErrors.INVITATION_NOT_FOUND, { expected: true });

/**
 * Lời mời email (spec SP3 §9.1, §8.4 đường b). Route có org chạy trong OrgScope của interceptor; route cầm token
 * (preview, accept) tra hàm definer theo hash rồi tự vào `OrgScope(orgId)`. Mọi ghi trong MỘT transaction theo thứ tự
 * khoá §8.6: org → tenancy_users → lời mời → member `FOR SHARE`. Kết cục phải COMMIT rồi mới báo lỗi (hết hạn → EXPIRED,
 * kiểm lại không đạt → INVALIDATED) trả về dạng kết quả và ném SAU `uow.run`.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly facts: AuthFacts,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly members: MemberRepository,
    private readonly invitations: InvitationRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly inviteRole: InviteRole,
    private readonly grantor: GrantorRecheck,
    private readonly admission: MemberAdmission,
    private readonly memberViews: MemberService,
    private readonly emails: EmailNotifications,
    private readonly events: EventPublisher,
    private readonly features: TenancyFeatures,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  /** `status` là trạng thái hiệu lực (PENDING quá hạn → EXPIRED) theo giờ DB đọc một lần mỗi request. */
  async list(q: { page: number; pageSize: number; cap: number }): Promise<{
    rows: (InvitationRow & { status: InvitationStatus })[];
    total: number;
  }> {
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.invitations.list({
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      }),
      this.invitations.countUpTo(q.cap),
    ]);
    return {
      rows: rows.map((r) => ({
        ...r,
        status: effectiveInvitationStatus(r, now),
      })),
      total,
    };
  }

  async create(input: {
    email: string;
    roleId: string;
  }): Promise<InvitationRow> {
    this.features.require('emailInvitations');
    const acceptBase = this.cfg.invitationAcceptUrl;
    if (acceptBase === undefined)
      throw new Error(
        'email invitations are enabled without TENANCY_INVITATION_ACCEPT_URL',
      );
    await this.hooks.afterGuard();
    const inviterName = await this.inviterName(); // spec §9.1 bước 2: I/O ngoài (pool auth) TRƯỚC transaction
    return this.uow.run(async () => {
      const org = await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([
        INVITATIONS_WRITE,
      ]);
      const role = await this.inviteRole.bindable(
        input.roleId,
        actorOfMember(actor, permissions),
      );
      // T-11: đếm dưới khoá org (mọi đường tạo lời mời đều khoá org trước), theo `clock_timestamp()` sau khoá.
      if (
        (await this.invitations.countOpen()) >=
        this.cfg.maxPendingInvitationsPerOrg
      )
        throw new AppError(TenancyErrors.PENDING_INVITATIONS_LIMIT);
      await this.invitations.expireLapsedForEmail(input.email); // giải phóng `pending_email_uq` (T-4 còn lại do partial UNIQUE)
      const token = newAcquisitionToken();
      const inv = await this.invitations.insert({
        email: input.email,
        roleId: role.id,
        inviterMemberId: actor.id,
        tokenHashHex: token.hashHex,
        ttlSec: this.cfg.invitationTtlSec,
      });
      // Cùng transaction (`uow.run` lồng nhau dùng lại transaction): thư và lời mời cùng commit hoặc cùng mất.
      await this.emails.request({
        template: 'org-invitation',
        to: inv.email,
        params: {
          orgName: oneLine(org.name, DISPLAY_NAME_MAX),
          inviterName:
            inviterName === null
              ? null
              : oneLine(inviterName, DISPLAY_NAME_MAX),
          roleName: oneLine(roleLabelOf(role), DISPLAY_NAME_MAX),
          acceptUrl: tokenUrl(acceptBase, token.token),
          expiresAt: inv.expiresAt.toISOString(),
        },
        idempotencyKey: `org-invitation:${inv.publicId}`,
      });
      await this.events.publish(InvitationCreatedEvent, {
        data: { invitationId: inv.publicId, roleId: role.publicId },
        aggregate: {
          type: 'invitation',
          id: inv.publicId,
          version: inv.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return inv;
    });
  }

  /** CAS PENDING → REVOKED (T-21). PENDING quá hạn: ghi EXPIRED (chạm sau hạn, không event) rồi `409` SAU commit. */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    const outcome = await this.uow.run(
      async (): Promise<'REVOKED' | 'NOT_PENDING'> => {
        await this.lockActiveOrg();
        await this.reauth.require([INVITATIONS_WRITE]);
        const inv = await this.invitations.lockByPublicId(publicId);
        if (!inv) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        if (inv.status !== 'PENDING') return 'NOT_PENDING';
        if (isLapsed(inv.expiresAt, await this.orgs.clockNow())) {
          await this.invitations.resolve(inv.id, 'EXPIRED');
          return 'NOT_PENDING';
        }
        const role = pendingRole(inv);
        const done = await this.invitations.resolve(inv.id, 'REVOKED');
        if (!done)
          throw new Error('a locked PENDING invitation was no longer PENDING');
        await this.events.publish(InvitationRevokedEvent, {
          data: { invitationId: done.publicId, roleId: role.publicId },
          aggregate: {
            type: 'invitation',
            id: done.publicId,
            version: done.version,
          },
          actor: userActor(this.ctx, 'tenancy'),
        });
        return 'REVOKED';
      },
    );
    if (outcome === 'NOT_PENDING')
      throw new AppError(TenancyErrors.INVITATION_NOT_PENDING);
  }

  /** Spec §9.1 "Xem trước": mọi trạng thái khác PENDING hiệu lực, org xoá mềm, không tìm thấy → CÙNG một 404. */
  async preview(token: string): Promise<TokenPreview> {
    const match = await this.invitations.findByTokenHash(tokenHashHex(token));
    if (!match) throw notFound();
    const view = await this.scope.run(match.orgId, () =>
      this.uow.run(async (): Promise<TokenPreview | undefined> => {
        const org = await this.orgs.readCurrent();
        if (!org || org.deletedAt) return undefined;
        const inv = await this.invitations.findById(match.id);
        if (
          !inv ||
          effectiveInvitationStatus(inv, await this.orgs.clockNow()) !==
            'PENDING'
        )
          return undefined;
        return {
          orgName: org.name,
          roleName: roleLabelOf({
            systemKey: inv.roleSystemKey,
            name: inv.roleName,
          }),
          expiresAt: inv.expiresAt,
        };
      }),
    );
    if (!view) throw notFound();
    return view;
  }

  async accept(token: string): Promise<{ orgId: string; member: MemberView }> {
    const { orgId, member } = await tenancySpan(
      'tenancy.invitation.accept',
      () => this.acceptOnce(token),
      () => ({ 'tenancy.acquisition.result': 'accepted' }),
    );
    // Sau commit: hồ sơ hiển thị qua directory (I/O ngoài, không trong transaction).
    return {
      orgId,
      member: await this.scope.run(orgId, () =>
        this.memberViews.get(member.publicId),
      ),
    };
  }

  private async acceptOnce(
    token: string,
  ): Promise<{ orgId: string; member: MemberRow }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    // Spec §9.1 bước 1: local/hybrid = email đã xác thực của user; external = claim email khi claim verified === true.
    const verified = this.facts.verifiedEmail();
    if (verified === undefined)
      throw new AppError(IdentityErrors.EMAIL_NOT_VERIFIED);
    const match = await this.invitations.findByTokenHash(tokenHashHex(token));
    if (!match) {
      this.metrics.invitations.add(1, { result: 'not_found' });
      throw notFound();
    }
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx, 'tenancy');
    let outcome: AcceptOutcome;
    try {
      outcome = await this.scope.run(match.orgId, () =>
        this.uow.run(async (): Promise<AcceptOutcome> => {
          const org = await this.orgs.lockCurrent();
          if (!org || org.deletedAt) return { kind: 'NOT_FOUND' }; // T-27: xoá mềm thắng thì lời mời đã REVOKED
          const user = await lockAdmittedUser(this.users, subject);
          const inv = await this.invitations.lockById(match.id);
          if (!inv || inv.status !== 'PENDING') return { kind: 'NOT_FOUND' };
          if (inv.email !== verified) {
            this.metrics.invitations.add(1, { result: 'email_mismatch' });
            // rollback: lời mời giữ PENDING, không nêu email. `expected`: một dòng warn chỉ mang mã (tiêu chí 16),
            // dấu vết cho người vận hành khi có ai cầm token đúng đăng nhập sai tài khoản.
            throw new AppError(TenancyErrors.INVITATION_EMAIL_MISMATCH, {
              expected: true,
            });
          }
          if (isLapsed(inv.expiresAt, await this.orgs.clockNow())) {
            await this.invitations.resolve(inv.id, 'EXPIRED'); // §3.15: so SAU khi có khoá; commit rồi 404
            return { kind: 'NOT_FOUND' };
          }
          const ref = pendingRole(inv);
          const check = await this.grantor.check(inv.inviterMemberId, {
            id: ref.id,
            systemKey: inv.roleSystemKey,
          });
          if (!check.ok) {
            const done = await this.invitations.resolve(inv.id, 'INVALIDATED');
            if (!done)
              throw new Error(
                'a locked PENDING invitation was no longer PENDING',
              );
            await this.events.publish(InvitationInvalidatedEvent, {
              data: {
                invitationId: done.publicId,
                roleId: ref.publicId,
                reason: check.reason,
              },
              aggregate: {
                type: 'invitation',
                id: done.publicId,
                version: done.version,
              },
              actor,
            });
            return { kind: 'INVALIDATED' };
          }
          const role = await this.roles.findByPublicId(ref.publicId);
          if (!role)
            throw new Error(
              'the role of a PENDING invitation vanished under the org lock',
            );
          const member = await this.admission.admit({
            user,
            role,
            actor,
            admission: { source: 'INVITATION', invitationId: inv.publicId },
          });
          // T-2: CAS cuối cùng; 0 dòng (hết hạn giữa lần đọc giờ và câu này) → ném để rollback cả membership.
          const accepted = await this.invitations.accept(inv.id, member.id);
          if (!accepted) {
            this.metrics.invitations.add(1, { result: 'not_found' });
            throw notFound();
          }
          await this.events.publish(InvitationAcceptedEvent, {
            data: {
              invitationId: accepted.publicId,
              roleId: role.publicId,
              memberId: member.publicId,
            },
            aggregate: {
              type: 'invitation',
              id: accepted.publicId,
              version: accepted.version,
            },
            actor,
          });
          return { kind: 'ACCEPTED', member };
        }),
      );
    } catch (err) {
      // T-3: `UNIQUE (org_id, user_id)` → 409 already_member qua constraint map; lời mời giữ PENDING (rollback).
      if (pgFields(err)?.constraint === ALREADY_MEMBER_CONSTRAINT)
        this.metrics.invitations.add(1, { result: 'already_member' });
      // Chế độ single-org (`MemberAdmission`): user đã ở org khác.
      else if (
        err instanceof AppError &&
        err.error === TenancyErrors.ALREADY_IN_AN_ORG
      )
        this.metrics.invitations.add(1, { result: 'already_in_org' });
      // Spec SP4 §9.6: org đầy ghế (`MemberAdmission`, port `MemberSeatLimit`).
      else if (
        err instanceof AppError &&
        err.error === CoreErrors.QUOTA_EXCEEDED
      )
        this.metrics.invitations.add(1, { result: 'seat_limit' });
      throw err;
    }
    switch (outcome.kind) {
      case 'ACCEPTED':
        this.metrics.invitations.add(1, { result: 'accepted' });
        return { orgId: match.orgId, member: outcome.member };
      case 'NOT_FOUND':
        this.metrics.invitations.add(1, { result: 'not_found' });
        throw notFound();
      case 'INVALIDATED':
        this.metrics.invitations.add(1, { result: 'invalidated' });
        throw new AppError(TenancyErrors.INVITATION_INVALIDATED);
      default: {
        const unknown: never = outcome;
        throw new Error(`unknown accept outcome ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async lockActiveOrg(): Promise<OrgRow> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt)
      throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
    return org;
  }

  /** Local/hybrid: tên người mời qua directory; external: `null` (không có directory, template cho phép; spec §5.2, §11). */
  private async inviterName(): Promise<string | null> {
    if (this.identity.mode === 'external' || !this.directory) return null;
    const ref = this.ctx.orgAccess()?.ref;
    const me =
      ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!me?.authUserId) return null;
    return (await this.directory.findUser(me.authUserId))?.name ?? null;
  }
}
