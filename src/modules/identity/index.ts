export { IdentityModule } from './identity.module.js';
export { SessionOnly } from './http/session-only.decorator.js';
export { IdentityErrors } from './errors.js';
export { UserRegisteredEvent } from './events.js';
export {
  IdentityDirectory,
  type DirectoryUser,
} from './ports/identity-directory.js';
export {
  identityConfig,
  identityGuardConfig,
  authDatabaseConfig,
} from './identity.config.js';
export { PrincipalResolver } from './http/principal-resolver.js';
export type { AuthResult } from './ports/auth-provider.js';
export {
  ORG_API_KEY_PREFIX,
  OrgCredentialAuthenticator,
} from './ports/org-credential-authenticator.js';
