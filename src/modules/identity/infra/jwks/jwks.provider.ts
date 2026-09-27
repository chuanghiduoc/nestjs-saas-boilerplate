import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { HttpClient, toWebFetch } from '../../../../core/resilience/index.js';
import type { DetectedCredential } from '../../http/credential-detector.js';
import { identitySpan, safeErrorFields } from '../../identity-telemetry.js';
import { identityConfig, type IdentityConfig } from '../../identity.config.js';
import { AuthProvider, type AuthResult } from '../../ports/auth-provider.js';

/** Tên provider của breaker/bulkhead trong `HttpClient` (hằng số, không phải host). */
export const IDP_JWKS_PROVIDER = 'idp-jwks';
const MAX_SUB_LENGTH = 255;
const REQUIRED_CLAIMS = ['exp', 'iat', 'sub'];
const REJECTED: AuthResult = { kind: 'REJECTED' };
const UNAVAILABLE: AuthResult = { kind: 'UNAVAILABLE' };

type ExternalKind = 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER';
type Verified =
  | { ok: true; payload: JWTPayload }
  | { ok: false; result: AuthResult; err: unknown };

/**
 * Lỗi của jose do IdP/JWKS chứ không do token: hết thời gian tải (`JWKSTimeout`), JWKS/JWK hỏng
 * (`JWKSInvalid`, `JWKInvalid`), và `JOSEError` gốc — jose 6 chỉ ném lớp gốc ở `fetchJwks` (status khác 200,
 * body không phải JSON). Token xấu không bao giờ sinh ra các lỗi này, nên chúng là `UNAVAILABLE` (503), không 401.
 */
const isJwksFailure = (err: errors.JOSEError): boolean =>
  err instanceof errors.JWKSTimeout ||
  err instanceof errors.JWKSInvalid ||
  err instanceof errors.JWKInvalid ||
  err.code === errors.JOSEError.code;

/**
 * `AUTH_MODE=external` (spec §5.6.3): một resolver JWKS cho cả process, fetch đi qua `HttpClient` chặn SSRF và
 * bọc policy resilience của provider `idp-jwks` (`toWebFetch`: timeout của jose thật sự huỷ request). Không đi
 * theo `jku`/`x5u`. Chỉ nhận token của user. Token và `sub` không bao giờ vào log hay span.
 */
@Injectable()
export class JwksAuthProvider extends AuthProvider {
  private readonly logger = new Logger(JwksAuthProvider.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    @Inject(identityConfig.KEY) private readonly cfg: IdentityConfig,
    http: HttpClient,
  ) {
    super();
    // Config rule đã bắt buộc biến này ở external; mất nó ở đây là lỗi nối dây module, phải nổ lúc boot.
    if (!cfg.externalJwksUrl)
      throw new Error('AUTH_EXTERNAL_JWKS_URL is required in external mode');
    this.jwks = createRemoteJWKSet(new URL(cfg.externalJwksUrl), {
      timeoutDuration: cfg.externalJwksTimeoutMs,
      cooldownDuration: cfg.externalJwksCooldownMs,
      cacheMaxAge: cfg.externalJwksCacheMaxAgeMs,
      [customFetch]: toWebFetch(http, IDP_JWKS_PROVIDER),
    });
  }

  async authenticate(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult> {
    const { kind, value } = input.credential;
    switch (kind) {
      case 'EXTERNAL_COOKIE':
      case 'EXTERNAL_BEARER':
        // Span chỉ mang kết quả phân loại, không token/sub (spec §5.14).
        return identitySpan(
          'identity.jwt.verify',
          () => this.verify(value, kind),
          (r) => ({ 'identity.auth.result': r.kind }),
        );
      // Không thuộc mode này: 401, không bao giờ rơi về ANONYMOUS (hợp đồng của `detectCredentials`).
      case 'SESSION_COOKIE':
      case 'BEARER_SESSION':
      case 'API_KEY':
        return REJECTED;
      default: {
        const unknown: never = kind;
        throw new Error(`unknown credential kind ${String(unknown)}`);
      }
    }
  }

  private async verify(token: string, kind: ExternalKind): Promise<AuthResult> {
    const v = await this.verifySignature(token);
    if (!v.ok) {
      if (v.result.kind === 'UNAVAILABLE')
        this.logger.warn(
          {
            event: 'auth_unavailable',
            credentialKind: kind,
            ...safeErrorFields(v.err),
          },
          'IdP JWKS unavailable',
        );
      return v.result;
    }
    const { payload } = v;
    const sub = payload.sub;
    if (
      typeof sub !== 'string' ||
      sub.length === 0 ||
      sub.length > MAX_SUB_LENGTH
    )
      return REJECTED;
    const userClaim = this.cfg.externalUserClaim;
    if (!userClaim || payload[userClaim] !== this.cfg.externalUserClaimValue)
      return REJECTED;
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: sub },
      credential: { kind },
      isPlatformAdmin: this.isAdmin(payload),
    };
  }

  private async verifySignature(token: string): Promise<Verified> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.externalIssuer,
        audience: this.cfg.externalAudience,
        algorithms: this.cfg.externalAlgorithms,
        clockTolerance: this.cfg.externalClockToleranceSec,
        requiredClaims: REQUIRED_CLAIMS,
        ...(this.cfg.externalTyp ? { typ: this.cfg.externalTyp } : {}),
        ...(this.cfg.externalMaxTokenAgeSec
          ? { maxTokenAge: `${this.cfg.externalMaxTokenAgeSec}s` }
          : {}),
      });
      return { ok: true, payload };
    } catch (err) {
      if (err instanceof errors.JOSEError)
        return {
          ok: false,
          result: isJwksFailure(err) ? UNAVAILABLE : REJECTED,
          err,
        };
      // Ngoài jose: lỗi của `HttpClient` khi tải JWKS (`UpstreamError`, `SsrfBlockedError`, …): IdP không dùng được.
      return { ok: false, result: UNAVAILABLE, err };
    }
  }

  /** So khớp chính xác (chuỗi bằng nhau, hoặc mảng chứa đúng phần tử); không so chuỗi con, không đổi hoa thường. */
  private isAdmin(payload: JWTPayload): boolean {
    const { externalAdminClaim: claim, externalAdminValue: value } = this.cfg;
    if (!claim || !value) return false;
    const v = payload[claim];
    return v === value || (Array.isArray(v) && v.includes(value));
  }
}
