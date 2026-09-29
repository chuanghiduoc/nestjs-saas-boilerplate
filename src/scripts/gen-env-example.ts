import { writeFileSync } from 'node:fs';
import '../core/config/all-configs.js';
import '../modules/notifications/notifications.config.js';
import '../modules/identity/identity.config.js';
import '../modules/tenancy/tenancy.config.js';
import '../modules/entitlements/entitlements.config.js';
import { DEV_INFRA_NAMESPACE } from '../core/config/dev-infra.config.js';
import { configRegistry, renderEnvExample } from '../core/config/index.js';

/**
 * Hai file tách theo người dùng: `.env.example` (→ `.env`) là config của app, được đưa vào
 * container app qua `env_file`; `.env.infra.example` (→ `.env.infra`) là config/secret của hạ tầng
 * compose, chỉ dùng để nội suy (`--env-file .env.infra`), không bao giờ vào container app.
 */
const APP_HEADER = [
  '# App config (copy to .env). Reaches the app containers via compose env_file.',
  '# Compose infra secrets live in .env.infra (see .env.infra.example), never here.',
  '',
  '',
].join('\n');
const INFRA_HEADER = [
  '# Compose infra config (copy to .env.infra). Used only for compose interpolation',
  '# (--env-file .env.infra); never passed into the app containers.',
  '',
  '',
].join('\n');

const entries = configRegistry();
writeFileSync(
  '.env.example',
  APP_HEADER +
    renderEnvExample(
      entries.filter((e) => e.namespace !== DEV_INFRA_NAMESPACE),
    ),
);
writeFileSync(
  '.env.infra.example',
  INFRA_HEADER +
    renderEnvExample(
      entries.filter((e) => e.namespace === DEV_INFRA_NAMESPACE),
    ),
);
