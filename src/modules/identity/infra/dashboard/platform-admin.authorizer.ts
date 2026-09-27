import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
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
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
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
      case 'AUTHENTICATED':
        return r.isPlatformAdmin
          ? { allowed: true }
          : this.deny(CoreErrors.FORBIDDEN, credential.kind);
      case 'ANONYMOUS':
      case 'REJECTED':
        return this.deny(CoreErrors.UNAUTHENTICATED, credential.kind);
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
