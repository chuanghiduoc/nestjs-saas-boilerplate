import { writeFileSync } from 'node:fs';
import '../core/config/all-configs.js';
import '../core/config/dev-infra.config.js';
import { configRegistry, renderEnvExample } from '../core/config/index.js';

writeFileSync('.env.example', renderEnvExample(configRegistry()));
