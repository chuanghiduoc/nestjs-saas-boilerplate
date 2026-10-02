import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { isDbInfraError } from '../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  type ErrorCode,
} from '../../../core/errors/index.js';
import { routeTemplateOf } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import { errorClass } from '../identity-telemetry.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../identity.config.js';
import { StaffStepUp } from '../infra/better-auth/staff-step-up.js';
import {
  NOOP_PLATFORM_ACCESS_AUDIT,
  PlatformAccessAudit,
  type PlatformAccessEntry,
} from '../ports/platform-access-audit.js';
import { AuthState } from './auth-state.js';
import { decideStaffAccess } from './staff-access.js';

const MS_PER_SECOND = 1000;
type Req = IncomingMessage & { params?: Record<string, unknown> };

/**
 * Addendum A1.2–A1.4: chạy SAU mọi APP_GUARD (route-scoped), TRƯỚC mọi interceptor (A-D1). Ở local/hybrid dùng đúng câu
 * dấu TOTP của `staff-step-up.ts` và ngưỡng `AUTH_SESSION_FRESH_AGE_SEC`; ở external đòi `auth_time` tươi. Cho qua → ghi
 * audit (ném → 503, handler không chạy); từ chối → không ghi audit (A-D6).
 */
@Injectable()
export class PlatformStaffGuard implements CanActivate {
  private readonly logger = new Logger(PlatformStaffGuard.name);

  constructor(
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
    @Optional() private readonly stepUp?: StaffStepUp,
    @Optional() private readonly audit?: PlatformAccessAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = this.state.get();
    const mode = this.identity.mode;
    let d = decideStaffAccess({
      auth,
      mode,
      authTimeFresh: this.authTimeFresh(),
    });
    if (d === 'CHECK_TOTP_MARK') {
      if (
        auth.kind !== 'AUTHENTICATED' ||
        auth.sessionId === undefined ||
        !this.stepUp
      )
        throw new Error(
          'PlatformStaffGuard needs StaffStepUp and a session id for a Better Auth staff session',
        );
      let fresh: boolean;
      try {
        fresh = await this.stepUp.totpMarkFresh(
          auth.principal.id,
          auth.sessionId,
          this.identity.sessionFreshAgeSec,
        );
      } catch (err) {
        if (!isDbInfraError(err)) throw err;
        this.metrics.platformStaffDecisions.add(1, { result: 'unavailable' });
        this.logger.warn(
          {
            event: 'platform_staff_mark_unavailable',
            errorClass: errorClass(err),
          },
          'the staff step-up mark could not be read; the request is refused with 503',
        );
        throw this.unavailable();
      }
      d = decideStaffAccess({ auth, mode, totpMarkFresh: fresh });
    }
    switch (d) {
      case 'ALLOW':
        break;
      case 'UNAUTHENTICATED':
        return this.deny('unauthenticated', CoreErrors.UNAUTHENTICATED);
      case 'FORBIDDEN':
        return this.deny('forbidden', CoreErrors.FORBIDDEN);
      case 'SECOND_FACTOR_REQUIRED':
        return this.deny(
          'second_factor_required',
          IdentityErrors.SECOND_FACTOR_REQUIRED,
        );
      case 'REAUTHENTICATION_REQUIRED':
        return this.deny(
          'reauthentication_required',
          IdentityErrors.REAUTHENTICATION_REQUIRED,
        );
      case 'CHECK_TOTP_MARK':
        throw new Error('decideStaffAccess asked for the TOTP mark twice');
      default: {
        const unknown: never = d;
        throw new Error(`unknown staff decision ${String(unknown)}`);
      }
    }
    if (auth.kind !== 'AUTHENTICATED')
      throw new Error('an ALLOW decision without a principal');
    const kind = auth.credential.kind;
    if (kind === 'API_KEY' || kind === 'ORG_API_KEY')
      throw new Error('an ALLOW decision for an API key');
    const req = context.switchToHttp().getRequest<Req>();
    const entry: PlatformAccessEntry = {
      method: (req.method ?? 'GET').toUpperCase(),
      routeTemplate:
        routeTemplateOf(context.getClass(), context.getHandler())[0] ?? '',
      params: Object.fromEntries(
        Object.entries(req.params ?? {}).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      ),
      actor: { type: 'user', id: auth.principal.id },
      credentialKind: kind,
    };
    try {
      await (this.audit ?? NOOP_PLATFORM_ACCESS_AUDIT).record(entry);
    } catch (err) {
      this.metrics.platformStaffDecisions.add(1, { result: 'audit_failed' });
      this.logger.error(
        { event: 'platform_access_audit_failed', errorClass: errorClass(err) },
        'platform access audit failed; the staff request is refused',
      );
      throw this.unavailable();
    }
    this.metrics.platformStaffDecisions.add(1, { result: 'allowed' });
    return true;
  }

  /** Cùng luật `@RequireFreshSession()` ở external (SP3 §11, SEC-I6): thiếu `auth_time` → không tươi; không fallback `iat`. */
  private authTimeFresh(): boolean {
    const a = this.state.get();
    if (a.kind !== 'AUTHENTICATED' || a.authenticatedAt === undefined)
      return false;
    const ageMs = Date.now() - a.authenticatedAt.getTime();
    return (
      ageMs <= this.identity.sessionFreshAgeSec * MS_PER_SECOND &&
      ageMs >= -this.identity.externalClockToleranceSec * MS_PER_SECOND
    );
  }

  private unavailable(): AppError {
    return new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
      headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) },
      expected: true,
    });
  }

  private deny(result: string, error: ErrorCode): never {
    this.metrics.platformStaffDecisions.add(1, { result });
    this.logger.debug(
      { event: 'platform_staff_denied', reason: error.code },
      'platform staff route refused',
    );
    throw new AppError(error, { expected: true });
  }
}
