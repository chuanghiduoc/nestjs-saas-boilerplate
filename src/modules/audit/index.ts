import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4, R-X16): import module này là đăng ký config, event, partition của nó.
markModuleLoaded('audit');

export { AuditModule } from './audit.module.js';
export { auditConfig, type AuditConfig } from './audit.config.js';
export { AuditPermissions } from './permissions.js';
export { StaffAccessRecordedEvent } from './events.js';
