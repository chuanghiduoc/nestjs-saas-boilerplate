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
