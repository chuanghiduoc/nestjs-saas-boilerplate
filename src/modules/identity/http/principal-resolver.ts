import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf, appConfig } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { PreAuthRateLimiter, httpConfig } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import { identitySpan } from '../identity-telemetry.js';
import { identityConfig, type IdentityConfig } from '../identity.config.js';
import { AuthProvider, type AuthResult } from '../ports/auth-provider.js';
import {
  OrgCredentialAuthenticator,
  isOrgApiKey,
} from '../ports/org-credential-authenticator.js';
import { AuthState } from './auth-state.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectedCredential,
  type DetectionConfig,
} from './credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  isCookieCredential,
  singleHeader,
  trustedOriginList,
} from './origin-check.js';
import { toWebHeaders } from './web-headers.js';

/**
 * Khoá CLS giữ PROMISE của lần xác định principal (không phải cờ "đã chạy", không suy từ `AuthState`: `get()` trả
 * ANONYMOUS cả khi chưa đặt). Đặt đồng bộ, trước khi bất kỳ caller nào khác có thể chạy.
 */
const RESOLUTION = 'identity:principalResolution';
const REJECTED: AuthResult = { kind: 'REJECTED' };

/**
 * Xác định principal của request, IDEMPOTENT (spec SP3 §5.2, §7.1 bước 2, T6, INT-I1): Nest 12.1 sắp middleware theo
 * `distance` của module, nên `OrgContextMiddleware` (tenancy) có thể chạy trước `PrincipalMiddleware`; cả hai gọi
 * `ensure`, và mọi lần gọi trong cùng request nhận CÙNG một promise, nên mỗi request xác thực đúng một lần bất kể thứ
 * tự. Hệ quả (phòng thủ nhiều lớp trên đường auth): lần gọi đồng thời chờ kết quả thật thay vì thấy ANONYMOUS; lần đầu
 * lỗi (đa credential, CSRF, 429 pre-auth, lỗi hạ tầng) thì mọi lần sau reject cùng lỗi đó, không ai thấy ANONYMOUS
 * sau một thất bại.
 */
@Injectable()
export class PrincipalResolver {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    private readonly ctx: RequestContext,
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    private readonly preAuth: PreAuthRateLimiter,
    private readonly cls: ClsService,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
    @Optional() private readonly orgCredentials?: OrgCredentialAuthenticator,
  ) {
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(
      trustedOriginList(http.corsOrigins, identity.baseUrl),
    );
  }

  ensure(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
  ): Promise<void> {
    // Fail loud: mọi request HTTP có CLS từ `contextMiddleware()`; thiếu CLS là lỗi nối dây, không được xác thực
    // mà không nhớ kết quả (mỗi lần gọi sẽ tiêu thêm điểm pre-auth và gọi lại provider).
    if (!this.cls.isActive())
      return Promise.reject(
        new Error('PrincipalResolver.ensure requires an active CLS context'),
      );
    // Chỉ `ensure` ghi khoá này (luôn một `Promise<void>`), nên getter có kiểu của nestjs-cls là an toàn.
    const pending = this.cls.get<Promise<void> | undefined>(RESOLUTION);
    if (pending) return pending;
    // `resolve` chạy đồng bộ tới `await` đầu tiên rồi trả promise; `set` ngay sau đó, trước khi event loop cho bất kỳ
    // caller nào khác chạy, nên không có cửa sổ hai lần xác thực.
    const resolution = this.resolve(req, res);
    this.cls.set(RESOLUTION, resolution);
    return resolution;
  }

  private async resolve(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
  ): Promise<void> {
    const d = detectCredentials(req.rawHeaders, this.detection);
    if (!d.ok) {
      this.metrics.ambiguous.add(1);
      throw new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS);
    }
    const credential = d.credentials[0];
    if (!credential) {
      this.state.set({ kind: 'ANONYMOUS' });
      return;
    }
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
    ) {
      this.metrics.csrfRejected.add(1);
      throw new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED);
    }
    // S2-R51: mọi API key (kể cả `oak_`) bị giới hạn theo IP trước khi chạm storage; hoàn điểm khi thành công (S2-R53).
    if (credential.kind === 'API_KEY') await this.preAuth.consume(req);
    const result = await identitySpan(
      'identity.authenticate',
      () => this.authenticate(req, credential),
      (r) => ({
        'identity.credential.kind': credential.kind,
        'identity.auth.result': r.kind,
      }),
    );
    this.state.set(result);
    switch (result.kind) {
      case 'AUTHENTICATED':
        if (credential.kind === 'API_KEY') await this.preAuth.refund(req);
        this.forwardCookies(res, result.setCookies);
        this.ctx.setPrincipal(result.principal);
        this.ctx.setCredential(result.credential);
        return;
      case 'REJECTED':
        this.forwardCookies(res, result.setCookies);
        return;
      case 'UNAVAILABLE':
        this.metrics.unavailable.add(1);
        return;
      case 'EMAIL_NOT_VERIFIED':
      case 'ANONYMOUS':
        return;
      default: {
        const unknown: never = result;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** `oak_…` không bao giờ tới Better Auth (spec §5.2): port của tenancy, vắng thì 401. */
  private authenticate(
    req: IncomingMessage,
    credential: DetectedCredential,
  ): Promise<AuthResult> {
    if (credential.kind === 'API_KEY' && isOrgApiKey(credential.value))
      return this.orgCredentials
        ? this.orgCredentials.authenticate(credential.value)
        : Promise.resolve(REJECTED);
    return this.provider.authenticate({
      headers: toWebHeaders(req),
      credential,
    });
  }

  /** Mỗi `Set-Cookie` một header riêng (RFC 6265 §3). */
  private forwardCookies(
    res: ServerResponse,
    setCookies: readonly string[] | undefined,
  ): void {
    for (const c of setCookies ?? []) res.appendHeader('Set-Cookie', c);
  }
}
