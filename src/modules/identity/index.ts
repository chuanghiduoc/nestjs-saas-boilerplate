import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('identity');

export { IdentityModule } from './identity.module.js';
export { SessionOnly } from './http/session-only.decorator.js';
export { AuthFacts } from './http/auth-facts.js';
export {
  RequireFreshSession,
  RequireVerifiedEmail,
} from './http/fresh-session.decorator.js';
export { IdentityErrors } from './errors.js';
export { UserRegisteredEvent } from './events.js';
export { PlatformRoleChangeListener } from './ports/platform-role-change-listener.js';
export {
  IdentityDirectory,
  isBanned,
  type DirectoryUser,
} from './ports/identity-directory.js';
export {
  identityConfig,
  identityGuardConfig,
  authDatabaseConfig,
} from './identity.config.js';
export { PrincipalResolver } from './http/principal-resolver.js';
/** Tenancy chuẩn hoá email được mời bằng CÙNG hàm với email đã xác thực (spec SP3 §9.1 bước 1). */
export { normalizeEmail } from './infra/better-auth/email-normalize.js';
export type { AuthResult } from './ports/auth-provider.js';
export {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from './ports/user-deletion-guard.js';
export {
  ORG_API_KEY_PREFIX,
  OrgCredentialAuthenticator,
} from './ports/org-credential-authenticator.js';
