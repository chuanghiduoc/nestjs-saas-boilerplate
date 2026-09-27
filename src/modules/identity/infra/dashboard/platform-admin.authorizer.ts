import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { CoreErrors, type ErrorCode } from '../../../../core/errors/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import {
  QueueDashboardAuthorizer,
  type QueueDashboardDecision,
} from '../../../../core/queue/index.js';
import { IdentityErrors } from '../../errors.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectionConfig,
} from '../../http/credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  isCookieCredential,
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

const deny = (
  error: ErrorCode,
  headers?: Record<string, string>,
): QueueDashboardDecision => ({
  allowed: false,
  error,
  ...(headers ? { headers } : {}),
});
const single = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Chỉ platform admin đăng nhập bằng session (cookie/bearer) mới xem được Bull Board (spec §5.12); API key luôn
 * bị từ chối, không tra storage. Cùng thứ tự kiểm với `PrincipalMiddleware` (đa credential → CSRF → authenticate)
 * nhưng không dùng `AuthState`/`RequestContext`: dashboard là một `express()` riêng ngoài cây Nest HTTP của api.
 *
 * Không chuyển tiếp `Set-Cookie` gia hạn (`AuthResult.setCookies`, Task 37): `QueueDashboardAuthorizer.authorize`
 * (Task 44, đã chốt) chỉ nhận `req`, không có `res`, và `QueueDashboardDecision` chỉ mang `headers` ở nhánh từ
 * chối (dùng cho `Retry-After`) — mở rộng hai kiểu đó để cõng cookie ở nhánh cho phép là việc của Task 44, ngoài
 * phạm vi task này. Tác động: một phiên đăng nhập chỉ dùng để xem dashboard trong thời gian dài sẽ không được
 * gia hạn trượt qua cổng dashboard và có thể phải đăng nhập lại sớm hơn; không có rủi ro bảo mật hay đúng đắn vì
 * dashboard chỉ đọc.
 */
@Injectable()
export class PlatformAdminAuthorizer extends QueueDashboardAuthorizer {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
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
    if (!d.ok) return deny(IdentityErrors.AMBIGUOUS_CREDENTIALS);
    const credential = d.credentials[0];
    if (!credential) return deny(CoreErrors.UNAUTHENTICATED);
    if (credential.kind === 'API_KEY') return deny(CoreErrors.FORBIDDEN);
    const method = (req.method ?? 'GET').toUpperCase();
    if (
      !SAFE_METHODS.has(method) &&
      isCookieCredential(credential.kind) &&
      !csrfAllows(
        {
          method,
          origin: single(req, 'origin'),
          secFetchSite: single(req, 'sec-fetch-site'),
        },
        this.trusted,
      )
    )
      return deny(IdentityErrors.ORIGIN_NOT_ALLOWED);
    const r = await this.provider.authenticate({
      headers: toWebHeaders(req),
      credential,
    });
    switch (r.kind) {
      case 'AUTHENTICATED':
        return r.isPlatformAdmin
          ? { allowed: true }
          : deny(CoreErrors.FORBIDDEN);
      case 'ANONYMOUS':
      case 'REJECTED':
        return deny(CoreErrors.UNAUTHENTICATED);
      case 'UNAVAILABLE':
        return deny(CoreErrors.SERVICE_UNAVAILABLE, {
          'Retry-After': String(this.guard.unavailableRetryAfterSec),
        });
      default: {
        const unknown: never = r;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }
}
