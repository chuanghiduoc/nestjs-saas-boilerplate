import { Injectable, Module } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionCatalogueContributor } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { defineCatalogue } from '../../../src/modules/tenancy/domain/catalogue.js';
import { buildTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

const Fixture = defineCatalogue('fixture', {
  'fixture.read': {
    resource: 'fixture',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: false, member: false },
  },
});
@Injectable()
@PermissionCatalogueContributor(Fixture)
class FixtureContributor {}
@Module({ providers: [FixtureContributor] })
class FixtureCatalogueModule {}

describe('CatalogueCheck (spec SP3 §8.8, tiêu chí 14)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  it('the migrated database matches the tenancy catalogue: the app boots (api boot: every tenancy e2e)', async () => {
    const app = await buildTestApp(tenancyCoreImports());
    close = () => app.close();
    await expect(app.init()).resolves.toBe(app);
  });
  it('a registered catalogue the migrations never seeded refuses to boot, naming the key', async () => {
    const app = await buildTestApp([
      ...tenancyCoreImports(),
      FixtureCatalogueModule,
    ]);
    close = () => app.close();
    await expect(app.init()).rejects.toThrow(
      /fixture\.read: in code, missing in the database/,
    );
  });
});
