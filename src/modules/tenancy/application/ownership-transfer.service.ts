import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  type FieldError,
} from '../../../core/errors/index.js';
import {
  EventPublisher,
  userActor,
  type EventActor,
} from '../../../core/events/index.js';
import {
  IdentityDirectory,
  identityConfig,
  type DirectoryUser,
} from '../../identity/index.js';
import {
  DISPLAY_NAME_MAX,
  EmailNotifications,
} from '../../notifications/index.js';
import type { StepDownRole, SystemRoleKey } from '../constants.js';
import { oneLine } from '../domain/display-text.js';
import { isLapsed } from '../domain/expiry.js';
import {
  effectiveTransferStatus,
  type TransferStatus,
} from '../domain/ownership-transfer.js';
import { TenancyErrors } from '../errors.js';
import {
  MemberRoleChangedEvent,
  OwnershipTransferAcceptedEvent,
  OwnershipTransferCancelledEvent,
  OwnershipTransferDeclinedEvent,
  OwnershipTransferRequestedEvent,
} from '../events.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import {
  OwnershipTransferRepository,
  type TransferRow,
} from '../ports/ownership-transfer-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { transferEventData } from './transfer-settlement.js';

const OWNERSHIP_TRANSFER = 'ownership.transfer';
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';
type Recipient = { member: MemberRow; user: DirectoryUser | undefined };
type Resolution =
  | { kind: 'DONE'; row: TransferRow }
  | { kind: 'NOT_PENDING' }
  | { kind: 'INVALIDATED' };
const recipientInvalid = (message: string) =>
  new AppError(CoreErrors.VALIDATION_FAILED, {
    fields: [
      {
        path: 'toMemberId',
        code: 'invalid_recipient',
        message,
      } satisfies FieldError,
    ],
  });
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Chuyển quyền sở hữu hai bên (spec SP3 §9.3, PR13, §8.4 đường d). Mọi ghi trong một transaction đã khoá org; thứ tự khoá
 * org → yêu cầu → member `FOR SHARE` (id tăng dần). Kết cục cần COMMIT trước khi báo lỗi (hết hạn → EXPIRED, người khởi tạo
 * hết là owner → CANCELLED, DB-M11) trả về dạng kết quả và ném sau `uow.run`. Đây là đường DUY NHẤT để owner tự xuống quyền.
 */
@Injectable()
export class OwnershipTransferService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly members: MemberRepository,
    private readonly transfers: OwnershipTransferRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly rolePermissions: RolePermissions,
    private readonly emails: EmailNotifications,
    private readonly events: EventPublisher,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  /** INT-M2: người có `ownership.transfer` thấy mọi yêu cầu; người khác chỉ yêu cầu mình là bên gửi/nhận. */
  async list(q: {
    status?: TransferStatus;
    page: number;
    pageSize: number;
    cap: number;
  }): Promise<{
    rows: (TransferRow & { status: TransferStatus })[];
    total: number;
  }> {
    const me = await this.self();
    const sees = new Set(
      await this.rolePermissions.of({ id: me.roleId, systemKey: me.systemKey }),
    ).has(OWNERSHIP_TRANSFER);
    const filter = {
      status: q.status,
      participantMemberId: sees ? undefined : me.id,
    };
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.transfers.list({
        ...filter,
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      }),
      this.transfers.countUpTo(filter, q.cap),
    ]);
    return {
      rows: rows.map((t) => ({
        ...t,
        status: effectiveTransferStatus(t, now),
      })),
      total,
    };
  }

  async create(input: {
    toMemberId: string;
    stepDownTo: StepDownRole | null;
  }): Promise<TransferRow> {
    await this.hooks.afterGuard();
    const recipient = await this.recipient(input.toMemberId); // directory (pool auth) TRƯỚC transaction
    const initiatorName = await this.nameOf(await this.self());
    return this.uow.run(async () => {
      const org = await this.lockActiveOrg();
      const { actor, locked } = await this.reauth.require(
        [OWNERSHIP_TRANSFER],
        [recipient.member.id],
      );
      const to = locked.find((m) => m.id === recipient.member.id);
      if (!to)
        throw recipientInvalid(
          'toMemberId is not a member of this organization',
        );
      if (to.id === actor.id)
        throw recipientInvalid('the recipient must be another member');
      await this.transfers.expireLapsed(); // chạm sau hạn: giải phóng `pending_uq` trước INSERT (không event)
      const t = await this.transfers.insert({
        fromMemberId: actor.id,
        toMemberId: to.id,
        stepDownTo: input.stepDownTo,
        ttlSec: this.cfg.ownershipTransferTtlSec,
      });
      // Local/hybrid: thư tới người nhận cùng transaction; external: không thư (không có email), người nhận dùng GET (INT-M3).
      if (recipient.user)
        await this.emails.request({
          template: 'ownership-transfer-requested',
          to: recipient.user.email,
          params: {
            name: oneLine(recipient.user.name, DISPLAY_NAME_MAX),
            orgName: oneLine(org.name, DISPLAY_NAME_MAX),
            requestedByName: oneLine(
              initiatorName ?? 'An owner',
              DISPLAY_NAME_MAX,
            ),
            expiresAt: t.expiresAt.toISOString(),
          },
          idempotencyKey: `ownership-transfer-requested:${t.publicId}`,
        });
      await this.events.publish(OwnershipTransferRequestedEvent, {
        data: transferEventData(t),
        aggregate: {
          type: 'ownership_transfer',
          id: t.publicId,
          version: t.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return t;
    });
  }

  async accept(publicId: string): Promise<TransferRow> {
    await this.hooks.afterGuard();
    const r = await this.lastOwnerGuarded(() =>
      this.uow.run(async (): Promise<Resolution> => {
        await this.lockActiveOrg();
        const t = await this.transfers.lockByPublicId(publicId);
        if (!t) throw notFound();
        const { actor, locked } = await this.reauth.require(
          [],
          t.fromMemberId === null ? [] : [t.fromMemberId],
        );
        if (t.toMemberId !== actor.id) throw notFound(); // Review Focus 5: không lộ yêu cầu cho người khác
        const pending = await this.stillPending(t);
        if (!pending) return { kind: 'NOT_PENDING' };
        const from = locked.find((m) => m.id === t.fromMemberId);
        const by = userActor(this.ctx, 'tenancy');
        if (!from || from.systemKey !== 'OWNER') {
          // DB-M11: commit CANCELLED rồi 409 (spec §8.4 đường d).
          const data = transferEventData(t);
          const done = await this.mustResolve(t, 'CANCELLED');
          await this.publishCancelled(done, data, 'INITIATOR_NOT_OWNER', by);
          return { kind: 'INVALIDATED' };
        }
        const data = transferEventData(t);
        const done = await this.mustResolve(t, 'ACCEPTED');
        const system = await this.systemRoles();
        // Người nhận lên OWNER TRƯỚC, rồi mới hạ người khởi tạo: trigger hoãn owner cuối luôn thấy ≥ 1 owner.
        if (actor.systemKey !== 'OWNER')
          await this.changeRole(actor, system.OWNER, by);
        if (t.stepDownTo !== null)
          await this.changeRole(from, system[t.stepDownTo], by);
        await this.events.publish(OwnershipTransferAcceptedEvent, {
          data,
          aggregate: {
            type: 'ownership_transfer',
            id: done.publicId,
            version: done.version,
          },
          actor: by,
        });
        return { kind: 'DONE', row: done };
      }),
    );
    return this.settled(r);
  }

  /** Thu hẹp (`@NarrowingTenancyAction()`): người nhận từ chối. */
  async decline(publicId: string): Promise<TransferRow> {
    const r = await this.uow.run(async (): Promise<Resolution> => {
      await this.lockActiveOrg();
      const t = await this.transfers.lockByPublicId(publicId);
      if (!t) throw notFound();
      const { actor } = await this.reauth.require([]);
      if (t.toMemberId !== actor.id) throw notFound();
      if (!(await this.stillPending(t))) return { kind: 'NOT_PENDING' };
      const data = transferEventData(t);
      const done = await this.mustResolve(t, 'DECLINED');
      await this.events.publish(OwnershipTransferDeclinedEvent, {
        data,
        aggregate: {
          type: 'ownership_transfer',
          id: done.publicId,
          version: done.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return { kind: 'DONE', row: done };
    });
    return this.settled(r);
  }

  /** Thu hẹp: mọi owner (`ownership.transfer`, ownerOnly) huỷ yêu cầu đang chờ. */
  async cancel(publicId: string): Promise<void> {
    const r = await this.uow.run(async (): Promise<Resolution> => {
      await this.lockActiveOrg();
      await this.reauth.require([OWNERSHIP_TRANSFER]);
      const t = await this.transfers.lockByPublicId(publicId);
      if (!t) throw notFound();
      if (!(await this.stillPending(t))) return { kind: 'NOT_PENDING' };
      const data = transferEventData(t);
      const done = await this.mustResolve(t, 'CANCELLED');
      await this.publishCancelled(
        done,
        data,
        'CANCELLED',
        userActor(this.ctx, 'tenancy'),
      );
      return { kind: 'DONE', row: done };
    });
    this.settled(r);
  }

  /** PENDING và còn hạn theo `clock_timestamp()` sau khoá; PENDING quá hạn được ghi EXPIRED (không event, §14.1). */
  private async stillPending(t: TransferRow): Promise<boolean> {
    if (t.status !== 'PENDING') return false;
    if (!isLapsed(t.expiresAt, await this.orgs.clockNow())) return true;
    await this.transfers.resolve(t.id, 'EXPIRED');
    return false;
  }

  private async mustResolve(
    t: TransferRow,
    to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED',
  ): Promise<TransferRow> {
    const done = await this.transfers.resolve(t.id, to); // T-16: CAS PENDING → to
    if (!done)
      throw new Error(
        'a locked PENDING ownership transfer was no longer PENDING',
      );
    return done;
  }

  private publishCancelled(
    done: TransferRow,
    data: ReturnType<typeof transferEventData>,
    reason: 'CANCELLED' | 'INITIATOR_NOT_OWNER',
    actor: EventActor,
  ) {
    return this.events.publish(OwnershipTransferCancelledEvent, {
      data: { ...data, reason },
      aggregate: {
        type: 'ownership_transfer',
        id: done.publicId,
        version: done.version,
      },
      actor,
    });
  }

  private settled(r: Resolution): TransferRow {
    switch (r.kind) {
      case 'DONE':
        return r.row;
      case 'NOT_PENDING':
        throw new AppError(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING);
      case 'INVALIDATED':
        throw new AppError(TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED);
      default: {
        const unknown: never = r;
        throw new Error(
          `unknown transfer resolution ${JSON.stringify(unknown)}`,
        );
      }
    }
  }

  private async changeRole(
    m: MemberRow,
    role: RoleRow,
    actor: EventActor,
  ): Promise<void> {
    if (m.roleId === role.id) return;
    const updated = await this.members.changeRole(m.id, role.id);
    await this.events.publish(MemberRoleChangedEvent, {
      data: {
        memberId: updated.publicId,
        userId: updated.userPublicId,
        fromRoleId: m.rolePublicId,
        toRoleId: updated.rolePublicId,
        reason: 'OWNERSHIP_TRANSFER',
      },
      aggregate: {
        type: 'member',
        id: updated.publicId,
        version: updated.version,
      },
      actor,
    });
  }

  private async systemRoles(): Promise<Record<SystemRoleKey, RoleRow>> {
    const all = await this.roles.list();
    const pick = (k: SystemRoleKey): RoleRow => {
      const r = all.find((x) => x.systemKey === k);
      if (!r)
        throw new Error(
          `system role ${k} missing (organizations_bootstrap_ck)`,
        );
      return r;
    };
    return {
      OWNER: pick('OWNER'),
      ADMIN: pick('ADMIN'),
      MEMBER: pick('MEMBER'),
    };
  }

  /** O-7: người nhận phải là member khác và (local/hybrid) có email đã xác thực; external: IdP chịu trách nhiệm. */
  private async recipient(toMemberPublicId: string): Promise<Recipient> {
    const member = await this.members.findByPublicId(toMemberPublicId);
    if (!member)
      throw recipientInvalid('toMemberId is not a member of this organization');
    if (
      this.identity.mode === 'external' ||
      !this.directory ||
      member.authUserId === null
    )
      return { member, user: undefined };
    const user = await this.directory.findUser(member.authUserId);
    if (!user?.emailVerified)
      throw recipientInvalid('the recipient must have a verified email');
    return { member, user };
  }

  private async nameOf(m: MemberRow): Promise<string | null> {
    if (
      this.identity.mode === 'external' ||
      !this.directory ||
      m.authUserId === null
    )
      return null;
    return (await this.directory.findUser(m.authUserId))?.name ?? null;
  }

  private async self(): Promise<MemberRow> {
    const ref = this.ctx.orgAccess()?.ref;
    const me =
      ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!me) throw notFound();
    return me;
  }

  private async lockActiveOrg(): Promise<OrgRow> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound(); // T-12, O-10
    return org;
  }

  /** Trigger hoãn owner cuối bắn lúc COMMIT; 409 do constraint map, ở đây chỉ đếm metric path `transfer` (§16). */
  private async lastOwnerGuarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === LAST_OWNER_CONSTRAINT)
        this.metrics.lastOwnerBlocked.add(1, { path: 'transfer' });
      throw err;
    }
  }
}
