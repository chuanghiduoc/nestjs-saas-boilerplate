import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4, R-X16): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('integrations');

export { IntegrationsModule } from './integrations.module.js';
export {
  integrationsConfig,
  type IntegrationsConfig,
} from './integrations.config.js';
export { IntegrationsErrors } from './errors.js';
export {
  DeliveryExhaustedEvent,
  EndpointCreatedEvent,
  EndpointDeletedEvent,
  EndpointDisabledEvent,
  EndpointEnabledEvent,
  EndpointSecretRotatedEvent,
  EndpointUpdatedEvent,
} from './events.js';
export { WebhookPermissions } from './permissions.js';
export { WebhookDeliveryKillSwitch } from './kill-switches.js';
