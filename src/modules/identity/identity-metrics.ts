import { Global, Injectable, Module } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { IDENTITY_METER } from './identity-telemetry.js';

export const SIGN_IN_RESULTS = [
  'success',
  'invalid',
  'forbidden',
  'limited',
  'unavailable',
  'error',
] as const;
export type SignInResult = (typeof SIGN_IN_RESULTS)[number];

const FIRST_NON_SUCCESS = 300;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const SERVICE_UNAVAILABLE = 503;

/** Không label theo email/user/org (spec §5.14). */
@Injectable()
export class IdentityMetrics {
  private readonly meter = metrics.getMeter(IDENTITY_METER);
  readonly signIn = this.meter.createCounter('identity_sign_in_total', {
    description: 'Email/password sign-in outcomes',
  });
  readonly unavailable = this.meter.createCounter(
    'identity_auth_unavailable_total',
    {
      description: 'Requests answered 503 because auth storage was unavailable',
    },
  );
  /** Task 40 I3: mọi 5xx của Better Auth (bug hay lỗi storage); `storage` = kết quả probe DB auth. */
  readonly endpointError = this.meter.createCounter(
    'identity_auth_endpoint_error_total',
    {
      description:
        'Better Auth 5xx responses; answered 503 on /sign-in/* and /two-factor/* (fail closed) or when the auth DB is down, else 500',
    },
  );
  /** S2-R58/N6: nhánh chống dò email chạy lâu hơn mức sàn (phần vượt vẫn lộ); `path` là route cố định, không PII. */
  readonly enumerationFloorExceeded = this.meter.createCounter(
    'identity_enumeration_floor_exceeded_total',
    {
      description:
        'Anti-enumeration responses slower than AUTH_ENUMERATION_MIN_RESPONSE_MS (the floor no longer hides the branch)',
    },
  );
  readonly ambiguous = this.meter.createCounter(
    'identity_ambiguous_credentials_total',
    { description: 'Requests rejected for carrying more than one credential' },
  );
  readonly csrfRejected = this.meter.createCounter(
    'identity_csrf_rejected_total',
    {
      description: 'Cookie-authenticated requests rejected by the origin check',
    },
  );

  readonly clientIpUnresolved = this.meter.createCounter(
    'identity_client_ip_unresolved_total',
    {
      description:
        'Auth requests refused because the client IP could not be resolved (check HTTP_TRUST_PROXY)',
    },
  );

  /** Task 45 review M3: labelled by error code (`reason`), never by IP, user or credential value. */
  readonly dashboardDenied = this.meter.createCounter(
    'identity_dashboard_denied_total',
    { description: 'Bull Board dashboard requests denied, by reason' },
  );
  /** Spec SP3 §16 (3D): `result` ∈ marked | skipped | invalid_code | rate_limited | mark_failed; `method` ∈ totp | backup_code. */
  readonly stepUp = this.meter.createCounter(
    'identity_second_factor_step_up_total',
    {
      description: 'Staff step-up attempts in a session, by outcome and method',
    },
  );
  /** Spec SP3 §16 (3D, r5): `surface` ∈ factor | admin | token | dashboard. */
  readonly staffStepUpRequired = this.meter.createCounter(
    'identity_staff_step_up_required_total',
    {
      description:
        'Staff platform-power requests refused for lacking a fresh TOTP step-up, by surface',
    },
  );

  /** Phân loại theo status cuối cùng của `/sign-in/email`. */
  recordSignIn(status: number): void {
    this.signIn.add(1, { result: signInResultOf(status) });
  }
}

function signInResultOf(status: number): SignInResult {
  if (status < FIRST_NON_SUCCESS) return 'success';
  switch (status) {
    case UNAUTHORIZED:
      return 'invalid';
    case FORBIDDEN:
      return 'forbidden';
    case TOO_MANY_REQUESTS:
      return 'limited';
    case SERVICE_UNAVAILABLE:
      return 'unavailable';
    default:
      return 'error';
  }
}

@Global()
@Module({ providers: [IdentityMetrics], exports: [IdentityMetrics] })
export class IdentityMetricsModule {}
