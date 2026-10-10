import { afterAll, describe, expect, it, vi } from 'vitest';
import { FlagsModule } from '../../../src/core/flags/index.js';
import { SweepModule } from '../../../src/core/sweep/index.js';
import { WebhookEventCatalogueCheck } from '../../../src/modules/integrations/application/event-catalogue-check.js';
import { IntegrationsModule } from '../../../src/modules/integrations/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

describe('WebhookEventCatalogueCheck on the migrated database (spec SP6 §6.5)', () => {
  afterAll(() => vi.unstubAllEnvs());
  it('a worker composition of integrations boots against the rows of the webhooks migration', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    const app = await createTestApp([
      ...tenancyCoreImports({ integrationPermissions: false }),
      FlagsModule,
      SweepModule,
      IntegrationsModule.forWorker(),
    ]);
    try {
      expect([...app.get(WebhookEventCatalogueCheck).known()]).toContain(
        'tenancy.org.updated',
      );
    } finally {
      await app.close();
    }
  });
});
