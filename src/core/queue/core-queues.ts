import { defineQueue } from './job-definition.js';

export const MaintenanceQueue = defineQueue('maintenance', { kind: 'io' });
