import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { ORG_API_KEY_PREFIX } from '../../identity/index.js';
import { checkDelegatedScope } from '../domain/delegation.js';
import { assertCanManage } from '../domain/escalation.js';
import { newOrgApiKeySecret } from '../domain/org-api-key.js';
import { TenancyErrors } from '../errors.js';
import { ApiKeyCreatedEvent, ApiKeyRevokedEvent } from '../events.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import {
  OrgApiKeyRepository,
  type OrgApiKeyRow,
} from '../ports/org-api-key-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { scopeOrThrow } from './delegation-scope.js';
import { EscalationGuard } from './escalation-guard.js';
import { actorOfMember } from './invite-role.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

const WRITE_OWN = 'api_keys.write_own';
const WRITE_ALL = 'api_keys.write_all';
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Org API key (spec SP3 §10, §8.4 đường e). Tạo: dưới khoá org, đọc lại actor (T-10), phạm vi qua `checkDelegatedScope`
 * với quyền HIỆN TẠI của actor, đếm giới hạn dưới khoá (T-11). Thu hồi key của người khác: `api_keys.write_all` + luật 4,
 * 2a(v), 5 với quyền HIỆN TẠI của người tạo (`assertCanManage`). `…/mine`: chỉ key của chính member, không cần cửa (SEC2-N7).
 */
@Injectable()
export class OrgApiKeyService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly keys: OrgApiKeyRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly escalation: EscalationGuard,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  /** Không `@Idempotent()` ở route (S3-A8): retry tạo thêm một key thu hồi được, secret không vào Redis. */
  async create(i: {
    name: string;
    permissions: string[];
    expiresInSec: number;
  }): Promise<{ key: OrgApiKeyRow; token: string }> {
    if (i.expiresInSec > this.cfg.orgApiKeyMaxTtlSec)
      throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([WRITE_OWN]);
      const scope = scopeOrThrow(
        'API_KEY',
        checkDelegatedScope(
          'API_KEY',
          i.permissions,
          permissions,
          this.registry.merged(),
        ),
        this.escalation,
      );
      // T-11: đếm dưới khoá org; `clock_timestamp()` vì câu chạy sau khi chờ khoá (§3.15).
      if (
        (await this.keys.countActiveForMember(actor.id)) >=
        this.cfg.maxActiveOrgApiKeysPerMember
      )
        throw new AppError(TenancyErrors.API_KEYS_LIMIT);
      const secret = newOrgApiKeySecret(ORG_API_KEY_PREFIX);
      const key = await this.keys.insert({
        createdByMemberId: actor.id,
        name: i.name,
        tokenHashHex: secret.hashHex,
        keyHint: secret.hint,
        expiresInSec: i.expiresInSec,
        permissions: scope,
      });
      await this.events.publish(ApiKeyCreatedEvent, {
        data: {
          apiKeyId: key.publicId,
          createdByMemberId: actor.publicId,
          permissions: key.permissions,
          expiresAt: key.expiresAt.toISOString(),
        },
        aggregate: { type: 'api_key', id: key.publicId, version: key.version },
        actor: userActor(this.ctx),
      });
      return { key, token: secret.token };
    });
  }

  async list(q: {
    page: number;
    pageSize: number;
    cap: number;
    mine: boolean;
  }): Promise<{ rows: OrgApiKeyRow[]; total: number }> {
    const memberId = q.mine ? (await this.self()).id : undefined;
    const [rows, total] = await Promise.all([
      this.keys.list({
        memberId,
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      }),
      this.keys.countUpTo(memberId, q.cap),
    ]);
    return { rows, total };
  }

  /** `…/mine/{keyId}`: key của người khác (hoặc không có) → `404` (không lộ tồn tại). */
  async revokeMine(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor } = await this.reauth.require([]);
      const key = await this.keys.lockByPublicId(publicId);
      if (!key || key.createdByMemberId !== actor.id) throw notFound();
      await this.revokeLocked(key);
    });
  }

  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const found = await this.keys.findByPublicId(publicId);
      if (!found) throw notFound();
      // Thứ tự khoá §3.14: org → member (actor + người tạo, id tăng dần) → key.
      const { actor, permissions, locked } = await this.reauth.require(
        [WRITE_ALL],
        [found.createdByMemberId],
      );
      const creator = locked.find((m) => m.id === found.createdByMemberId);
      if (!creator) throw notFound(); // FK CASCADE: người tạo rời org thì key đã mất
      if (creator.id !== actor.id)
        this.escalation.enforce(
          assertCanManage(
            actorOfMember(actor, permissions),
            {
              memberRef: creator.publicId,
              isOwner: creator.systemKey === 'OWNER',
              permissions: new Set(
                await this.rolePermissions.of({
                  id: creator.roleId,
                  systemKey: creator.systemKey,
                }),
              ),
            },
            this.registry.merged(),
          ),
        );
      const key = await this.keys.lockByPublicId(publicId);
      if (!key) throw notFound();
      await this.revokeLocked(key);
    });
  }

  /** Đã thu hồi → no-op (`DELETE` idempotent; trigger trạng thái cuối giữ `revoked_at`). */
  private async revokeLocked(key: OrgApiKeyRow): Promise<void> {
    const done = await this.keys.revoke(key.id);
    if (!done) return;
    await this.events.publish(ApiKeyRevokedEvent, {
      data: { apiKeyId: done.publicId, reason: 'REVOKED' },
      aggregate: { type: 'api_key', id: done.publicId, version: done.version },
      actor: userActor(this.ctx),
    });
  }

  private async self(): Promise<MemberRow> {
    const access = this.ctx.orgAccess();
    if (access?.via !== 'MEMBERSHIP')
      throw new Error(
        'an api-keys/mine route ran without a MEMBERSHIP orgAccess',
      );
    const me = await this.members.findByPublicId(access.ref);
    if (!me) throw notFound();
    return me;
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound(); // T-12
  }
}
