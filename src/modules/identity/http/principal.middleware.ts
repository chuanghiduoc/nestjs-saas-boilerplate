import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf, appConfig } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { PreAuthRateLimiter, httpConfig } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import { identitySpan } from '../identity-telemetry.js';
import { identityConfig, type IdentityConfig } from '../identity.config.js';
import { AuthProvider } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectionConfig,
} from './credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  isCookieCredential,
  trustedOriginList,
} from './origin-check.js';
import { toWebHeaders } from './web-headers.js';

const single = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Principal xác định ở middleware, trước mọi guard (ADR 0007: thứ tự APP_GUARD giữa module không được bảo
 * đảm, mà `AppThrottlerGuard` cần principal). Không có credential → ANONYMOUS, không chạm DB auth.
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    private readonly ctx: RequestContext,
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    private readonly preAuth: PreAuthRateLimiter,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
  ) {
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(
      trustedOriginList(http.corsOrigins, identity.baseUrl),
    );
  }

  async use(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const d = detectCredentials(req.rawHeaders, this.detection);
      if (!d.ok) {
        this.metrics.ambiguous.add(1);
        return next(new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS));
      }
      const credential = d.credentials[0];
      if (!credential) {
        this.state.set({ kind: 'ANONYMOUS' });
        return next();
      }
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
      ) {
        this.metrics.csrfRejected.add(1);
        return next(new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED));
      }
      // S2-R51: API key không có principal để throttle trước khi tra storage (mỗi key rác một lookup + probe DB
      // auth, và path 404 không có guard nào): giới hạn theo IP ngay trước `authenticate`, sau CSRF. Hoàn điểm khi
      // xác thực thành công (S2-R53, ở switch dưới).
      if (credential.kind === 'API_KEY') await this.preAuth.consume(req);
      // Span không mang token/user id: chỉ loại credential và kết quả (spec §5.14).
      const result = await identitySpan(
        'identity.authenticate',
        () =>
          this.provider.authenticate({
            headers: toWebHeaders(req),
            credential,
          }),
        (r) => ({
          'identity.credential.kind': credential.kind,
          'identity.auth.result': r.kind,
        }),
      );
      this.state.set(result);
      switch (result.kind) {
        case 'AUTHENTICATED':
          // S2-R53: key hợp lệ được hoàn điểm (chỉ key rác còn đếm theo IP); REJECTED/UNAVAILABLE giữ điểm.
          if (credential.kind === 'API_KEY') await this.preAuth.refund(req);
          this.forwardCookies(res, result.setCookies);
          this.ctx.setPrincipal(result.principal);
          this.ctx.setCredential(result.credential);
          break;
        case 'REJECTED':
          // Session hết hạn: Better Auth xoá cookie; chuyển tiếp để client không gửi lại cookie chết.
          this.forwardCookies(res, result.setCookies);
          break;
        case 'UNAVAILABLE':
          this.metrics.unavailable.add(1);
          break;
        case 'ANONYMOUS':
          break;
        default: {
          const unknown: never = result;
          throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  /** Mỗi `Set-Cookie` một header riêng (RFC 6265 §3: không được gộp bằng dấu phẩy). */
  private forwardCookies(
    res: ServerResponse,
    setCookies: readonly string[] | undefined,
  ): void {
    for (const c of setCookies ?? []) res.appendHeader('Set-Cookie', c);
  }
}
