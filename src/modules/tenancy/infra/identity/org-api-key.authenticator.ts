import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../../core/config/index.js';
import {
  OrgScope,
  UnitOfWork,
  isDbInfraError,
} from '../../../../core/database/index.js';
import {
  IdentityDirectory,
  OrgCredentialAuthenticator,
  identityConfig,
  isBanned,
  type AuthResult,
} from '../../../identity/index.js';
import {
  TenancyMetrics,
  type OrgApiKeyAuthResult,
} from '../../application/tenancy-metrics.js';
import { orgApiKeyHashHex } from '../../domain/org-api-key.js';
import {
  OrgApiKeyRepository,
  type ActiveKeyAccess,
} from '../../ports/org-api-key-repository.js';

const REJECTED: AuthResult = { kind: 'REJECTED' };
const UNAVAILABLE: AuthResult = { kind: 'UNAVAILABLE' };

/**
 * Spec SP3 §7.1 bước 2, §10 (SEC-I4, SEC-I8): SHA-256 của toàn bộ chuỗi (mọi dạng `oak_…`, kể cả hoa/thường hay cắt cụt,
 * cho đúng 32 byte, Review Focus 1) → hàm definer (không cần OrgScope) → dòng key còn hạn, chưa thu hồi, org chưa xoá mềm,
 * người tạo còn member (FK CASCADE) → local/hybrid: user của người tạo còn, không bị ban, đã xác thực email. Mọi lỗi của
 * chính credential → `REJECTED` (401); lỗi hạ tầng → `UNAVAILABLE` (503), không ném. Lời gọi pool auth nằm NGOÀI transaction
 * của pool app.
 */
@Injectable()
export class OrgApiKeyAuthenticator extends OrgCredentialAuthenticator {
  private readonly logger = new Logger(OrgApiKeyAuthenticator.name);

  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly keys: OrgApiKeyRepository,
    private readonly metrics: TenancyMetrics,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {
    super();
  }

  async authenticate(rawKey: string): Promise<AuthResult> {
    let found: { orgId: string; access: ActiveKeyAccess } | undefined;
    try {
      found = await this.lookup(rawKey);
    } catch (err) {
      if (!isDbInfraError(err)) throw err;
      return this.done('unavailable', UNAVAILABLE);
    }
    if (!found) return this.done('invalid', REJECTED);
    const { orgId, access } = found;
    if (this.identity.mode !== 'external') {
      if (!this.directory)
        throw new Error(
          'org API keys in local/hybrid mode need IdentityDirectory',
        );
      // Người tạo seed ở external rồi đổi mode: không có auth user → key không dùng được (runbook đổi mode).
      if (access.creatorAuthUserId === null)
        return this.done('invalid', REJECTED);
      let user;
      try {
        user = await this.directory.findUser(access.creatorAuthUserId);
      } catch (err) {
        // Lỗi pg của pool auth không chứa giá trị của câu `findUser` ngoài id user (principal id, được phép log).
        this.logger.error(
          { event: 'org_api_key_directory_failed', err },
          'identity directory failed during org API key authentication',
        );
        return this.done('unavailable', UNAVAILABLE);
      }
      if (!user) return this.done('invalid', REJECTED);
      if (isBanned(user, new Date()))
        return this.done('creator_banned', REJECTED);
      if (!user.emailVerified) return this.done('creator_unverified', REJECTED);
    }
    return this.done('ok', {
      kind: 'AUTHENTICATED',
      principal: { type: 'api_key', id: access.keyPublicId },
      credential: { kind: 'ORG_API_KEY', id: access.keyPublicId, orgId },
      isPlatformAdmin: false,
      authenticatedAt: undefined,
      emailVerified: false,
      verifiedEmail: undefined,
      sessionId: undefined,
    });
  }

  private async lookup(
    rawKey: string,
  ): Promise<{ orgId: string; access: ActiveKeyAccess } | undefined> {
    const match = await this.keys.findByTokenHash(orgApiKeyHashHex(rawKey));
    if (!match) return undefined;
    const access = await this.scope.run(match.orgId, () =>
      this.uow.run(() => this.keys.findActiveForAccess(match.publicId)),
    );
    return access ? { orgId: match.orgId, access } : undefined;
  }

  private done(result: OrgApiKeyAuthResult, r: AuthResult): AuthResult {
    this.metrics.orgApiKeyAuth.add(1, { result });
    return r;
  }
}
