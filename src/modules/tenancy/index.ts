import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('tenancy');

export { TenancyModule } from './tenancy.module.js';
export { tenancyConfig, type TenancyConfig } from './tenancy.config.js';
export { TenancyErrors } from './errors.js';
export {
  OrgCreatedEvent,
  OrgUpdatedEvent,
  OrgDeletedEvent,
  OrgRestoredEvent,
  OrgPurgedEvent,
  MemberAddedEvent,
  MemberRoleChangedEvent,
  MemberRemovedEvent,
} from './events.js';
export { PermissionCatalogueContributor } from './application/permission-catalogue.registry.js';
export { OrgPurgeParticipantContributor } from './application/org-purge-participant.registry.js';
export { OrgPurgeParticipant } from './ports/org-purge-participant.js';
export {
  definePermissionCatalogue,
  OrgMemberOnly,
  type PermissionCatalogue,
} from './http/decorators.js';
