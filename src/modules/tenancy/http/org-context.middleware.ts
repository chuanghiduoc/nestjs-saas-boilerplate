import {
  type FactoryProvider,
  Inject,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import {
  RequestContext,
  type Credential,
  type OrgAccessVia,
  type Principal,
} from '../../../core/context/index.js';
import {
  OrgScope,
  UnitOfWork,
  isDbInfraError,
} from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  RateLimitBuckets,
  type RateLimitBucket,
} from '../../../core/http/index.js';
import {
  PrincipalResolver,
  identityGuardConfig,
} from '../../identity/index.js';
import { DelegatedPermissions } from '../application/authz/delegated-permissions.js';
import { RolePermissions } from '../application/authz/role-permissions.js';
import { SubjectResolver } from '../application/subject-resolver.js';
import {
  TenancyMetrics,
  type OrgAccessResult,
} from '../application/tenancy-metrics.js';
import { TenancyErrors } from '../errors.js';
import { AccessReader, type MembershipLookup } from '../ports/access-reader.js';
import { OrgApiKeyRepository } from '../ports/org-api-key-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { isOrgRestoreRequest } from './org-route.js';

type OrgRequest = IncomingMessage & {
  ip?: string;
  params?: Record<string, unknown>;
};
const OrgIdParam = z.uuid();
const MS_PER_SEC = 1000;
type Outcome = { via: OrgAccessVia; result: OrgAccessResult };

/** Token của handle bucket `tenancy.org-miss` (một instance mỗi app). */
export const ORG_MISS_BUCKET = Symbol('tenancy.org-miss');
/**
 * Review C1: Nest dựng middleware qua `MiddlewareContainer` riêng (`Injector.loadMiddleware`), KHÔNG dùng lại instance
 * provider, nên constructor của một middleware có thể chạy nhiều lần. Việc đăng ký bucket (ném khi trùng tên) vì vậy
 * nằm ở provider singleton này, không ở constructor của middleware.
 */
export const orgMissBucketProvider: FactoryProvider<RateLimitBucket> = {
  provide: ORG_MISS_BUCKET,
  inject: [RateLimitBuckets, tenancyConfig.KEY],
  useFactory: (
    buckets: RateLimitBuckets,
    cfg: ConfigOf<typeof tenancyConfig>,
  ): RateLimitBucket =>
    buckets.register({
      owner: 'tenancy',
      name: 'org-miss',
      ttlMs: cfg.orgMissTtlMs,
      limit: cfg.orgMissLimit,
      refundable: false,
    }),
};

/**
 * Spec SP3 §7.1 bước 3 (đăng ký `forRoutes(ORG_ROUTE_PATTERN)`, chạy trước throttler và idempotency). Mọi nhánh trượt
 * trả `404` từ MỘT chỗ; chỉ lần trượt thật ghi vào bucket `tenancy.org-miss` (peek trước, consume ngay trước `throw`).
 * Lỗi hạ tầng khi tra → `503` + `Retry-After`, không consume (SEC2-N6). Race T-33 (peek ∥ consume) được chấp nhận.
 * Constructor không có side effect (review C1): Nest được phép dựng lớp này nhiều lần.
 */
@Injectable()
export class OrgContextMiddleware implements NestMiddleware {
  constructor(
    private readonly principals: PrincipalResolver,
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly reader: AccessReader,
    private readonly subjects: SubjectResolver,
    private readonly rolePermissions: RolePermissions,
    private readonly keys: OrgApiKeyRepository,
    private readonly delegated: DelegatedPermissions,
    private readonly metrics: TenancyMetrics,
    @Inject(ORG_MISS_BUCKET) private readonly orgMiss: RateLimitBucket,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {}

  async use(
    req: OrgRequest,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    await this.principals.ensure(req, res);
    const principal = this.ctx.principal();
    if (!principal) {
      next();
      return;
    }
    const raw = req.params?.['orgId'];
    if (typeof raw !== 'string')
      throw new Error(
        'OrgContextMiddleware is mounted on a route without :orgId',
      );
    const parsed = OrgIdParam.safeParse(raw);
    if (!parsed.success)
      throw new AppError(CoreErrors.ORG_CONTEXT_INVALID, {
        detail: 'orgId must be a UUID',
      });
    const orgId = parsed.data.toLowerCase();
    await tenancySpan(
      'tenancy.org_context.resolve',
      () => this.resolve(req, principal, orgId),
      (outcome) => ({
        'tenancy.access.via': outcome.via,
        'tenancy.access.result': outcome.result,
      }),
    );
    next();
  }

  private async resolve(
    req: OrgRequest,
    principal: Principal,
    orgId: string,
  ): Promise<Outcome> {
    const credential = this.ctx.credential();
    if (credential?.kind === 'API_KEY') {
      this.count('MEMBERSHIP', 'user_key_rejected');
      throw new AppError(TenancyErrors.API_KEY_NOT_ORG_SCOPED);
    }
    const via: OrgAccessVia =
      credential?.kind === 'ORG_API_KEY' ? 'ORG_API_KEY' : 'MEMBERSHIP';
    const limiterKey = `principal:${principal.type}:${principal.id}`;
    const peek = await this.orgMiss.peek(limiterKey);
    if (peek.blocked) {
      this.count(via, 'rate_limited');
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(peek.retryAfterSec) },
        expected: true,
      });
    }
    if (credential?.kind === 'ORG_API_KEY')
      return this.resolveOrgKey(credential, orgId, limiterKey);
    const { membership: lookup, permissions } = await this.readInOrg(
      'MEMBERSHIP',
      orgId,
      async () => {
        const membership = await this.reader.lookup(
          this.subjects.of(principal),
        );
        const member = membership.org === 'PRESENT' ? membership.member : null;
        // Câu thứ hai của spec §7.3, chỉ cho role tuỳ biến; lỗi DB ở đây cũng rơi vào nhánh 503 (tiêu chí 12).
        const permissions = member
          ? await this.rolePermissions.of({
              id: member.roleId,
              systemKey: member.systemKey,
            })
          : [];
        return { membership, permissions };
      },
    );
    const member = this.admitted(req, lookup);
    if (!member) return this.miss('MEMBERSHIP', limiterKey);
    // OrgScope.run chỉ đặt org trong CLS con: đặt tường minh ở context của request (bước 3.9).
    this.ctx.setOrgId(orgId);
    this.ctx.setOrgAccess({
      via: 'MEMBERSHIP',
      ref: member.publicId,
      permissions,
      orgDeleted: lookup.org === 'PRESENT' && lookup.deletedAt !== null,
    });
    this.count('MEMBERSHIP', 'granted');
    return { via: 'MEMBERSHIP', result: 'granted' };
  }

  /**
   * Bước 3.6–3.7 nhánh key: key của org khác → trượt thật (cùng 404 + limiter như non-member, K-7); cùng org → phạm vi ∩
   * quyền HIỆN TẠI của người tạo (§8.5, T-30), đọc lại ở mỗi request (key bị thu hồi/người tạo bị gỡ giữa bước 2 và đây → trượt).
   */
  private async resolveOrgKey(
    credential: Credential,
    orgId: string,
    limiterKey: string,
  ): Promise<Outcome> {
    if (credential.id === undefined || credential.orgId === undefined)
      throw new Error('an ORG_API_KEY credential without id/orgId');
    const keyId = credential.id;
    const permissions =
      credential.orgId === orgId
        ? await this.readInOrg('ORG_API_KEY', orgId, async () => {
            const access = await this.keys.findActiveForAccess(keyId);
            return access ? this.delegated.forApiKey(access) : undefined;
          })
        : undefined;
    if (!permissions) return this.miss('ORG_API_KEY', limiterKey);
    this.ctx.setOrgId(orgId);
    this.ctx.setOrgAccess({
      via: 'ORG_API_KEY',
      ref: keyId,
      permissions,
      orgDeleted: false,
    });
    this.count('ORG_API_KEY', 'granted');
    return { via: 'ORG_API_KEY', result: 'granted' };
  }

  /** Chỗ DUY NHẤT ghi vào limiter và ném 404 (bước 3.8); lần consume làm vượt ngưỡng vẫn trả 404 (bị khoá từ request sau). */
  private async miss(via: OrgAccessVia, limiterKey: string): Promise<never> {
    await this.orgMiss.consume(limiterKey);
    this.count(via, 'not_found');
    throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  }

  /** Trúng = org có dòng + là member + (org hoạt động, hoặc route khôi phục trên org xoá mềm). */
  private admitted(req: OrgRequest, lookup: MembershipLookup) {
    if (lookup.org === 'MISSING' || lookup.member === null) return undefined;
    if (lookup.deletedAt !== null && !isOrgRestoreRequest(req))
      return undefined;
    return lookup.member;
  }

  /** Đọc trong OrgScope + transaction; lỗi hạ tầng → `503` + `Retry-After`, không consume limiter (SEC2-N6). */
  private async readInOrg<T>(
    via: OrgAccessVia,
    orgId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      return await this.scope.run(orgId, () => this.uow.run(fn));
    } catch (err) {
      if (!isDbInfraError(err)) throw err;
      this.count(via, 'unavailable');
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) },
        // Không gắn `cause`: với `expected: true` filter log `cause` nguyên văn, mà lỗi pg có thể mang giá trị khoá.
        expected: true,
      });
    } finally {
      this.metrics.orgContextDuration.record(
        (performance.now() - started) / MS_PER_SEC,
      );
    }
  }

  private count(via: OrgAccessVia, result: OrgAccessResult): void {
    this.metrics.orgAccess.add(1, { via, result });
  }
}
