import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { AuthFacts } from '../../identity/index.js';
import { TenancyErrors, TenancyUserVanishedError } from '../errors.js';
import { OrgCreatedEvent, OrgUpdatedEvent } from '../events.js';
import {
  OrgRepository,
  type OrgRow,
  type UserOrgRow,
} from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { MemberAdmission } from './member-admission.js';
import { OrgCreationParticipantRegistry } from './org-creation-participant.registry.js';
import { SubjectResolver } from './subject-resolver.js';

@Injectable()
export class OrgService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly facts: AuthFacts,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly admission: MemberAdmission,
    private readonly events: EventPublisher,
    private readonly reauth: ActorReauthorizer,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
    private readonly creationParticipants: OrgCreationParticipantRegistry,
  ) {}

  /**
   * Spec SP3 §9.4 "Tạo": id v7 sinh ở app (S3-A1), OrgScope(id) để `WITH CHECK` đạt; khoá `tenancy_users` của người tạo
   * TRƯỚC khi đếm (T-6); đếm cả org xoá mềm chưa purge (S3-A22). Trigger hoãn `organizations_bootstrap_ck` kiểm lúc COMMIT.
   */
  async create(input: { name: string }): Promise<OrgRow> {
    if (
      this.cfg.orgCreation === 'platform_admin' &&
      !this.facts.isPlatformAdmin()
    )
      throw new AppError(TenancyErrors.ORG_CREATION_DISABLED);
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx);
    const id = v7();
    return this.scope.run(id, () =>
      this.uow.run(async () => {
        const user = await this.lockUser(() =>
          this.users.upsertAndLock(subject),
        );
        if (
          (await this.orgs.countCreatedBy(user.id)) >=
          this.cfg.maxOrgsCreatedPerUser
        )
          throw new AppError(TenancyErrors.ORG_LIMIT_REACHED);
        const org = await this.orgs.insertCurrent({
          name: input.name,
          createdByUserId: user.id,
        });
        const roles = await this.roles.insertSystemRoles();
        // SP4 T1 (S4-D9): participant (vd. entitlements) ghi dòng của mình trong CÙNG transaction và OrgScope, trước khi
        // người tạo vào org (ghế của 4B đọc được gói ngay lúc admit người tạo). Participant ném → cả lần tạo rollback.
        for (const p of this.creationParticipants.participants())
          await p.participant.onOrgCreated(org.id, actor);
        await this.admission.admit({
          user,
          role: roles.OWNER,
          source: 'CREATOR',
          actor,
        });
        await this.events.publish(OrgCreatedEvent, {
          data: { orgId: org.id, createdByUserId: user.publicId },
          aggregate: { type: 'organization', id: org.id, version: org.version },
          actor,
        });
        return org;
      }),
    );
  }

  /** Không tạo `tenancy_users` (Review Focus 2); đếm bằng cùng điều kiện với danh sách (Review Focus 3). */
  async list(q: {
    includeDeleted: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ rows: UserOrgRow[]; total: number }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const user = await this.users.find(this.subjects.of(principal));
    if (!user) return { rows: [], total: 0 };
    const [rows, total] = await Promise.all([
      this.orgs.listForUser(
        user.id,
        q.includeDeleted,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ),
      this.orgs.countForUser(user.id, q.includeDeleted),
    ]);
    return { rows, total };
  }

  async get(): Promise<OrgRow> {
    const org = await this.orgs.readCurrent();
    if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return org;
  }

  /** Khoá org rồi so version DƯỚI khoá: hai request cùng ETag → một 200, một 412 (Review Focus 4). */
  async rename(
    ifMatch: string | undefined,
    name: string | undefined,
  ): Promise<OrgRow> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org || org.deletedAt)
        throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
      await this.reauth.require(['org.update']);
      assertIfMatch(ifMatch, org.version, { required: true });
      if (name === undefined || name === org.name) return org;
      const updated = await this.orgs.rename(name);
      await this.events.publish(OrgUpdatedEvent, {
        data: { orgId: updated.id, changed: ['name'] },
        aggregate: {
          type: 'organization',
          id: updated.id,
          version: updated.version,
        },
        actor: userActor(this.ctx),
      });
      return updated;
    });
  }

  private async lockUser<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TenancyUserVanishedError)
        throw new AppError(CoreErrors.CONFLICT, {
          detail: 'This account is being deleted.',
          expected: true,
        });
      throw err;
    }
  }
}
