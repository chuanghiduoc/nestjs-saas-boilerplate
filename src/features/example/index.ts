// Public API của feature mẫu (spec SP7 §6.3.1): feature khác chỉ import từ đây (`features-only-public-api-of-other-features`).
export { ExampleModule } from './example.module.js';
export { ExampleEvents } from './events.js';
export { ExamplePermissions } from './permissions.js';
export { ExampleFeatures } from './entitlements.js';
export { exampleConfig, type ExampleConfig } from './example.config.js';
export { ExampleErrors } from './errors.js';
