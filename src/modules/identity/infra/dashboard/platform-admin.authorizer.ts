import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { isDbInfraError } from '../../../../core/database/index.js';
import { CoreErrors, type ErrorCode } from '../../../../core/errors/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import {
  QueueDashboardAuthorizer,
  type QueueDashboardDecision,
} from '../../../../core/queue/index.js';
import { IdentityErrors } from '../../errors.js';
import { IdentityMetrics } from '../../identity-metrics.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectedCredential,
  type DetectionConfig,
} from '../../http/credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  isCookieCredential,
  singleHeader,
  trustedOriginList,
} from '../../http/origin-check.js';
import { toWebHeaders } from '../../http/web-headers.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../../identity.config.js';
import { AuthProvider } from '../../ports/auth-provider.js';
import { errorClass } from '../../identity-telemetry.js';
import { StaffStepUp } from '../better-auth/staff-step-up.js';
import { decideStaffAccess, isAuthTimeFresh } from '../../http/staff-access.js';

/**
 * Chỉ platform admin đăng nhập bằng session (cookie/bearer) mới xem được Bull Board (spec §5.12); API key luôn
 * bị từ chối, không tra storage. Cùng thứ tự kiểm với `PrincipalMiddleware` (đa credential → CSRF → authenticate)
 * nhưng không dùng `AuthState`/`RequestContext`: dashboard là một `express()` riêng ngoài cây Nest HTTP của api.
 *
 * Không chuyển tiếp `Set-Cookie` (Task 37's renewal AND the REJECTED delete-dead-cookie case, review M4):
 * `QueueDashboardAuthorizer.authorize` (Task 44, đã chốt) chỉ nhận `req`, không có `res`, và
 * `QueueDashboardDecision` chỉ mang `headers` ở nhánh từ chối (dùng cho `Retry-After`) — mở rộng hai kiểu đó để
 * cõng cookie ở nhánh cho phép/từ chối là việc của Task 44, ngoài phạm vi task này. Tác động: một phiên đăng
 * nhập chỉ dùng để xem dashboard trong thời gian dài sẽ không được gia hạn trượt qua cổng dashboard và có thể
 * phải đăng nhập lại sớm hơn; một cookie đã hết hạn cũng không được xoá qua cổng này, trình duyệt tiếp tục gửi
 * và tiếp tục nhận 401. Không có rủi ro bảo mật hay đúng đắn vì dashboard chỉ đọc và mọi request đều được
 * `AuthProvider.authenticate` xác thực lại từ đầu.
 */
@Injectable()
export class PlatformAdminAuthorizer extends QueueDashboardAuthorizer {
  private readonly logger = new Logger(PlatformAdminAuthorizer.name);
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    private readonly metrics: IdentityMetrics,
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
    /** Chỉ `local`/`hybrid` (`BetterAuthCoreModule`, `@Global`); `external` không có Better Auth. */
    @Optional() private readonly stepUp?: StaffStepUp,
  ) {
    super();
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(
      trustedOriginList(http.corsOrigins, identity.baseUrl),
    );
  }

  async authorize(req: IncomingMessage): Promise<QueueDashboardDecision> {
    const d = detectCredentials(req.rawHeaders, this.detection);
    if (!d.ok) return this.deny(IdentityErrors.AMBIGUOUS_CREDENTIALS);
    const credential = d.credentials[0];
    if (!credential) return this.deny(CoreErrors.UNAUTHENTICATED);
    if (credential.kind === 'API_KEY')
      return this.deny(CoreErrors.FORBIDDEN, credential.kind);
    const method = (req.method ?? 'GET').toUpperCase();
    if (
      !SAFE_METHODS.has(method) &&
      isCookieCredential(credential.kind) &&
      !csrfAllows(
        {
          method,
          origin: singleHeader(req, 'origin'),
          secFetchSite: singleHeader(req, 'sec-fetch-site'),
        },
        this.trusted,
      )
    )
      return this.deny(IdentityErrors.ORIGIN_NOT_ALLOWED, credential.kind);
    const r = await this.provider.authenticate({
      headers: toWebHeaders(req),
      credential,
    });
    switch (r.kind) {
      case 'AUTHENTICATED': {
        // Review M-1 (addendum A1.2): CÙNG quyết định với `PlatformStaffGuard` cho mọi loại credential — session Better
        // Auth đòi dấu TOTP tươi, `external` đòi `auth_time` tươi, key bị từ chối. Không gọi lại `getSession`: `sessionId`
        // đến từ chính lần xác thực vừa rồi (lệch có chủ đích, plan 3D "File Structure").
        const mode = this.identity.mode;
        let d = decideStaffAccess({
          auth: r,
          mode,
          authTimeFresh: isAuthTimeFresh(r, this.identity),
        });
        if (d === 'CHECK_TOTP_MARK') {
          if (!this.stepUp || r.sessionId === undefined)
            throw new Error(
              'a Better Auth staff session reached the dashboard without StaffStepUp or a session id',
            );
          const fresh = await this.totpMarkFresh(
            r.principal.id,
            r.sessionId,
            credential.kind,
          );
          if (typeof fresh !== 'boolean') return fresh;
          d = decideStaffAccess({ auth: r, mode, totpMarkFresh: fresh });
        }
        switch (d) {
          case 'ALLOW':
            return { allowed: true };
          case 'UNAUTHENTICATED':
            return this.deny(CoreErrors.UNAUTHENTICATED, credential.kind);
          case 'FORBIDDEN':
            return this.deny(CoreErrors.FORBIDDEN, credential.kind);
          case 'SECOND_FACTOR_REQUIRED':
            return this.deny(
              IdentityErrors.SECOND_FACTOR_REQUIRED,
              credential.kind,
            );
          case 'REAUTHENTICATION_REQUIRED':
            return this.deny(
              IdentityErrors.REAUTHENTICATION_REQUIRED,
              credential.kind,
            );
          case 'CHECK_TOTP_MARK':
            throw new Error('decideStaffAccess asked for the TOTP mark twice');
          default: {
            const unknown: never = d;
            throw new Error(`unknown staff decision ${String(unknown)}`);
          }
        }
      }
      case 'ANONYMOUS':
      case 'REJECTED':
        return this.deny(CoreErrors.UNAUTHENTICATED, credential.kind);
      case 'EMAIL_NOT_VERIFIED':
        return this.deny(IdentityErrors.EMAIL_NOT_VERIFIED, credential.kind);
      case 'UNAVAILABLE':
        return this.deny(CoreErrors.SERVICE_UNAVAILABLE, credential.kind, {
          'Retry-After': String(this.guard.unavailableRetryAfterSec),
        });
      default: {
        const unknown: never = r;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Câu dấu TOTP của nhân viên; lỗi → quyết định từ chối 503 (không nuốt im: WARN có tên lớp lỗi, không message). */
  private async totpMarkFresh(
    userId: string,
    sessionId: string,
    credentialKind: DetectedCredential['kind'],
  ): Promise<boolean | QueueDashboardDecision> {
    if (!this.stepUp)
      throw new Error('the dashboard needs StaffStepUp for a staff session');
    try {
      return await this.stepUp.totpMarkFresh(
        userId,
        sessionId,
        this.identity.sessionFreshAgeSec,
      );
    } catch (err) {
      // Review M-2: cùng luật `PlatformStaffGuard` — chỉ lỗi hạ tầng của DB là 503; lỗi khác (bug, grant sai) ném lên (500).
      if (!isDbInfraError(err)) throw err;
      this.logger.warn(
        {
          event: 'dashboard_step_up_check_failed',
          errorClass: errorClass(err),
        },
        'queue dashboard: the staff step-up mark could not be read',
      );
      return this.deny(CoreErrors.SERVICE_UNAVAILABLE, credentialKind, {
        'Retry-After': String(this.guard.unavailableRetryAfterSec),
      });
    }
  }

  /**
   * Review M3: mọi từ chối được đếm (`reason` = mã lỗi, không PII) và log ở mức debug — đây là mặt admin, một
   * user đã xác thực nhưng không phải admin dò surface này, hay một đợt auth outage chỉ hiện ra như một loạt
   * 503 ở đây, phải để lại dấu vết. `credentialKind` (không phải giá trị credential) giúp phân biệt "chưa có
   * credential" khỏi "có mà bị chặn", vẫn không PII.
   */
  private deny(
    error: ErrorCode,
    credentialKind?: DetectedCredential['kind'],
    headers?: Record<string, string>,
  ): QueueDashboardDecision {
    this.metrics.dashboardDenied.add(1, { reason: error.code });
    if (error === IdentityErrors.SECOND_FACTOR_REQUIRED)
      this.metrics.staffStepUpRequired.add(1, { surface: 'dashboard' });
    this.logger.debug(
      {
        event: 'dashboard_authorization_denied',
        reason: error.code,
        credentialKind,
      },
      'queue dashboard: request denied',
    );
    return { allowed: false, error, ...(headers ? { headers } : {}) };
  }
}
