import {
  Global,
  Inject,
  Logger,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import type pg from 'pg';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { RequestContext } from '../../../../core/context/index.js';
import { UnitOfWork } from '../../../../core/database/index.js';
import { errorsConfig } from '../../../../core/errors/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import {
  FieldCipher,
  SecurityModule,
} from '../../../../core/security/index.js';
import { AuthEmails } from '../../application/auth-emails.js';
import {
  IdentityMetrics,
  IdentityMetricsModule,
} from '../../identity-metrics.js';
import { RegisteredEventService } from '../../application/registered-event.service.js';
import { SecurityNoticeService } from '../../application/security-notice.service.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../../identity.config.js';
import { AuthHousekeeping } from '../../ports/auth-housekeeping.js';
import { AuthProvider } from '../../ports/auth-provider.js';
import { IdentityDirectory } from '../../ports/identity-directory.js';
import { RegistrationLedger } from '../../ports/registration-ledger.js';
import { SecurityNoticeLedger } from '../../ports/security-notice-ledger.js';
import { UserDeletionGuard } from '../../ports/user-deletion-guard.js';
import { PlatformRoleChangeListener } from '../../ports/platform-role-change-listener.js';
import {
  BETTER_AUTH,
  assertAuthProvidersRegistered,
  createAuthInstance,
  type AuthInstance,
} from './auth-instance.js';
import { AUTH_POOL, authPoolProviders } from './auth-pool.provider.js';
import { AuthDatabaseReadiness } from './auth-readiness.js';
import { AuthRequestState } from './auth-request-state.js';
import { BetterAuthProvider } from './better-auth.provider.js';
import { LOGIN_LOCKOUT, LoginLockout } from './login-lockout.js';
import { PgAuthHousekeeping } from './pg-auth-housekeeping.js';
import { PgIdentityDirectory } from './pg-identity-directory.js';
import { PgRegistrationLedger } from './pg-registration-ledger.js';
import { PgSecurityNoticeLedger } from './pg-security-notice-ledger.js';
import { StaffStepUp } from './staff-step-up.js';

/**
 * Pool `auth_user`, instance Better Auth và các adapter; dùng ở api (kèm mount HTTP) và worker (không mount).
 * Chỉ nạp ở `local`/`hybrid` (`ConditionalModule.registerWhen(…, isBetterAuthMode)`, Task 37): ở `external` không
 * có pool auth, không có instance Better Auth, và `AuthProvider` do `JwksAuthProvider` cung cấp (Task 41).
 */
@Global()
@Module({
  imports: [SecurityModule, IdentityMetricsModule],
  providers: [
    ...authPoolProviders,
    PgIdentityDirectory,
    { provide: IdentityDirectory, useExisting: PgIdentityDirectory },
    PgRegistrationLedger,
    { provide: RegistrationLedger, useExisting: PgRegistrationLedger },
    PgSecurityNoticeLedger,
    { provide: SecurityNoticeLedger, useExisting: PgSecurityNoticeLedger },
    PgAuthHousekeeping,
    { provide: AuthHousekeeping, useExisting: PgAuthHousekeeping },
    { provide: AuthRequestState, useValue: new AuthRequestState() },
    {
      provide: LOGIN_LOCKOUT,
      inject: [AUTH_POOL, identityGuardConfig.KEY],
      useFactory: (pool: pg.Pool, g: IdentityGuardConfig) =>
        new LoginLockout(pool, {
          maxFailures: g.lockoutMaxFailures,
          windowSec: g.lockoutWindowSec,
          blockSec: g.lockoutBlockSec,
        }),
    },
    {
      provide: StaffStepUp,
      inject: [AUTH_POOL],
      useFactory: (pool: pg.Pool) => new StaffStepUp(pool),
    },
    AuthEmails,
    RegisteredEventService,
    SecurityNoticeService,
    {
      provide: BETTER_AUTH,
      inject: [
        identityConfig.KEY,
        identityGuardConfig.KEY,
        appConfig.KEY,
        httpConfig.KEY,
        errorsConfig.KEY,
        AUTH_POOL,
        FieldCipher,
        LOGIN_LOCKOUT,
        AuthEmails,
        IdentityDirectory,
        AuthRequestState,
        RegisteredEventService,
        SecurityNoticeService,
        UnitOfWork,
        RequestContext,
        { token: UserDeletionGuard, optional: true },
        { token: PlatformRoleChangeListener, optional: true },
        StaffStepUp,
        IdentityMetrics,
      ],
      useFactory: (
        identity: IdentityConfig,
        guard: IdentityGuardConfig,
        app: ConfigOf<typeof appConfig>,
        http: ConfigOf<typeof httpConfig>,
        errors: ConfigOf<typeof errorsConfig>,
        pool: pg.Pool,
        cipher: FieldCipher,
        lockout: LoginLockout,
        emails: AuthEmails,
        directory: IdentityDirectory,
        state: AuthRequestState,
        registered: RegisteredEventService,
        notices: SecurityNoticeService,
        uow: UnitOfWork,
        ctx: RequestContext,
        userDeletion: UserDeletionGuard | undefined,
        roleChange: PlatformRoleChangeListener | undefined,
        stepUp: StaffStepUp,
        metrics: IdentityMetrics,
      ) => {
        if (identity.mode === 'external')
          throw new Error(
            'BetterAuthCoreModule must not be loaded when AUTH_MODE=external (register it with isBetterAuthMode)',
          );
        return createAuthInstance({
          identity,
          guard,
          app,
          corsOrigins: http.corsOrigins,
          pool,
          cipher,
          lockout,
          emails,
          directory,
          state,
          onUserCreated: (userId) => registered.onUserCreated(userId),
          notifySecurityChange: (userId) => notices.afterChange(userId),
          inAppTransaction: () => uow.inTransaction(),
          userDeletion,
          requestId: () => ctx.requestId(),
          problemTypeBase: errors.problemTypeBase,
          logger: new Logger('better-auth'),
          stepUp,
          metrics,
          roleChange,
        });
      },
    },
    BetterAuthProvider,
    { provide: AuthProvider, useExisting: BetterAuthProvider },
    AuthDatabaseReadiness,
  ],
  exports: [
    AUTH_POOL,
    BETTER_AUTH,
    AuthProvider,
    IdentityDirectory,
    RegistrationLedger,
    SecurityNoticeLedger,
    AuthHousekeeping,
    AuthRequestState,
    LOGIN_LOCKOUT,
    StaffStepUp,
    AuthEmails,
    RegisteredEventService,
    SecurityNoticeService,
    // Mount (Task 36) hỏi lại pool bằng CHÍNH probe có hạn này khi Better Auth trả ≥ 500 (S2-R45/S2-R32).
    AuthDatabaseReadiness,
  ],
})
export class BetterAuthCoreModule implements OnModuleInit {
  constructor(
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  /**
   * S2-R37: Better Auth chỉ log rồi bỏ qua provider OIDC không đăng ký được; danh sách provider chỉ có sau `init`
   * bất đồng bộ. Chờ nó ở đây để lỗi dừng khởi động (api và worker) trước khi nhận request. Await `$context` cũng
   * làm lỗi của `init` (nếu có) nổ lúc boot thay vì thành unhandled rejection. Boot lỗi thì `main.*` thoát 1;
   * `app.close()` vẫn chạy được và đóng pool (`AuthPoolLifecycle`).
   */
  async onModuleInit(): Promise<void> {
    await assertAuthProvidersRegistered(
      this.auth,
      this.identity,
      this.app.role,
    );
  }
}
