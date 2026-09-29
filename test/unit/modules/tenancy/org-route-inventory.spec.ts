import {
  All,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Patch,
  Post,
  Search,
  SetMetadata,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ContextModule } from '../../../../src/core/context/index.js';
import { PublicRoute } from '../../../../src/core/http/index.js';
import {
  OrgRouteInventory,
  TENANCY_CONTROLLER_MODULES,
} from '../../../../src/modules/tenancy/application/org-route-inventory.js';
import {
  PermissionCatalogueContributor,
  PermissionCatalogueRegistry,
} from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import {
  NarrowingTenancyAction,
  OrgMemberOnly,
  SensitiveTenancyAction,
  TENANCY_POLICY,
  type TenancyPolicy,
  definePermissionCatalogue,
} from '../../../../src/modules/tenancy/http/decorators.js';
import { PoliciesGuard } from '../../../../src/modules/tenancy/http/policies.guard.js';

const entry = {
  requires: [],
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  grantTo: { admin: true, member: true },
};
const Fx = definePermissionCatalogue('fx', {
  'fx.read': { resource: 'fx', action: 'read', ...entry },
});
const Unregistered = definePermissionCatalogue('unreg', {
  'unreg.read': { resource: 'unreg', action: 'read', ...entry },
});
@Injectable()
@PermissionCatalogueContributor(Fx)
class FxContributor {}

@Controller('v1/orgs/:orgId')
class RestoreCtl {
  @Post('restore') @Fx.require('fx.read') @SensitiveTenancyAction() restore() {}
  @Delete('members/me') @OrgMemberOnly() @NarrowingTenancyAction() leave() {}
}
@Controller('v1/orgs/:orgId/things')
class GoodCtl {
  @Get() @Fx.require('fx.read') list() {}
  @Patch(':id') @Fx.require('fx.read') @SensitiveTenancyAction() edit() {}
}
@Controller('v1/orgs/:orgId/bad')
class MissingPolicy {
  @Get() list() {}
}
@Controller('v1/orgs/:id/bad')
class WrongParam {
  @Get() @Fx.require('fx.read') list() {}
}
@Controller('v1/orgs/me')
class StaticSegment {
  @Get() @OrgMemberOnly() list() {}
}
@Controller('v1/orgs/:orgId/pub')
class PublicTenant {
  @Get() @PublicRoute() @Fx.require('fx.read') list() {}
}
@Controller('v1/elsewhere')
class PolicyOutside {
  @Get() @Fx.require('fx.read') list() {}
}
@Controller('v1/orgs/:orgId/w')
class NoMarker {
  @Post() @Fx.require('fx.read') create() {}
}
@Controller('v1/orgs/:orgId/w2')
class BothMarkers {
  @Post()
  @Fx.require('fx.read')
  @SensitiveTenancyAction()
  @NarrowingTenancyAction()
  create() {}
}
@Controller('v1/orgs/:orgId/w3')
class AllMethod {
  @All() @Fx.require('fx.read') @SensitiveTenancyAction() any() {}
}
@Controller('v1/orgs/:orgId/w4')
class SearchMethod {
  @Search() @Fx.require('fx.read') @SensitiveTenancyAction() find() {}
}
@Controller('v1/orgs/:orgId/w5')
class UndeclaredNarrowing {
  @Delete() @Fx.require('fx.read') @NarrowingTenancyAction() revoke() {}
}
@Controller('v1/orgs/:orgId/u')
class UnregisteredCatalogue {
  @Get() @Unregistered.require('unreg.read') list() {}
}
@Controller('v1/orgs/:orgId')
class SecondRestore {
  @Post('restore/') @Fx.require('fx.read') @SensitiveTenancyAction() again() {}
}
@Controller('v1/orgs/:orgId/empty')
class EmptyKeys {
  // `require()` không nhận 0 key ở compile; metadata ghi tay mô phỏng decorator tự chế bỏ qua kiểu.
  @Get()
  @SetMetadata(TENANCY_POLICY, {
    kind: 'PERMISSIONS',
    catalogue: Fx,
    keys: [],
  } satisfies TenancyPolicy)
  @UseGuards(PoliciesGuard)
  list() {}
}
@Controller('v1/orgs/:orgId')
class MultiTemplateRestore {
  @Post(['restore', 'x'])
  @Fx.require('fx.read')
  @SensitiveTenancyAction()
  restore() {}
  @Delete('members/me') @OrgMemberOnly() @NarrowingTenancyAction() leave() {}
}

/** Deps của `PoliciesGuard` (Nest tạo guard của `UseGuards` như injectable của module chứa controller): toàn cục như `TenancyCoreModule`. */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PermissionCatalogueRegistry, TenancyMetrics, FxContributor],
  exports: [PermissionCatalogueRegistry, TenancyMetrics],
})
class GuardDeps {}

/** Dựng app không HTTP với các controller fixture; `tenancy` = controller nằm trong module thuộc luật G-8. */
async function inventoryOf(
  tenancy: Type[],
  others: Type[] = [],
): Promise<string[]> {
  @Module({ controllers: tenancy })
  class TenancyFixtureHttp {}
  @Module({ controllers: others })
  class FeatureFixtureHttp {}
  const ref = await Test.createTestingModule({
    imports: [
      ContextModule,
      DiscoveryModule,
      GuardDeps,
      TenancyFixtureHttp,
      FeatureFixtureHttp,
    ],
    providers: [
      OrgRouteInventory,
      { provide: TENANCY_CONTROLLER_MODULES, useValue: [TenancyFixtureHttp] },
    ],
  }).compile();
  // Chỉ onModuleInit (registry); inventory gọi tay để đọc vi phạm thay vì bắt lỗi boot.
  ref.get(PermissionCatalogueRegistry).onModuleInit();
  const problems = ref.get(OrgRouteInventory).check();
  await ref.close();
  return problems;
}

describe('OrgRouteInventory (spec SP3 §7.1 kiểm lúc khởi động, G-1, G-8)', () => {
  it('a well-formed route table has no problem', async () => {
    expect(await inventoryOf([RestoreCtl, GoodCtl])).toEqual([]);
  });
  it.each([
    [
      [MissingPolicy],
      /GET v1\/orgs\/:orgId\/bad: tenant route without a permission decorator or @OrgMemberOnly/,
    ],
    [
      [WrongParam],
      /v1\/orgs\/:id\/bad: routes under v1\/orgs\/ must name the org parameter :orgId/,
    ],
    [
      [StaticSegment],
      /v1\/orgs\/me: routes under v1\/orgs\/ must name the org parameter :orgId/,
    ],
    [[PublicTenant], /tenant route must not be @PublicRoute/],
    [
      [NoMarker],
      /POST v1\/orgs\/:orgId\/w: a tenancy write route needs exactly one of @SensitiveTenancyAction\/@NarrowingTenancyAction/,
    ],
    [
      [BothMarkers],
      /POST v1\/orgs\/:orgId\/w2: a tenancy write route needs exactly one/,
    ],
    [
      [AllMethod],
      /v1\/orgs\/:orgId\/w3: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE/,
    ],
    [
      [SearchMethod],
      /v1\/orgs\/:orgId\/w4: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE/,
    ],
    [
      [UndeclaredNarrowing],
      /narrowing routes differ from NARROWING_ROUTES: \+DELETE v1\/orgs\/:orgId\/w5/,
    ],
    [[UnregisteredCatalogue], /catalogue "unreg" is not registered/],
    [
      [SecondRestore],
      /exactly one POST v1\/orgs\/:orgId\/restore handler, found 2/,
    ],
  ])('G-1/G-8 fixture %# refuses to boot', async (extra, message) => {
    const problems = await inventoryOf([RestoreCtl, ...extra]);
    expect(problems.join('\n')).toMatch(message);
  });
  it('a permission decorator with no keys refuses to boot (it would grant every member)', async () => {
    expect((await inventoryOf([RestoreCtl, EmptyKeys])).join('\n')).toMatch(
      /GET v1\/orgs\/:orgId\/empty: permission decorator with no keys/,
    );
  });
  it('the restore handler has exactly one route template (a deleted org would reach the others)', async () => {
    expect((await inventoryOf([MultiTemplateRestore])).join('\n')).toMatch(
      /restore handler must have exactly one route template, found 2/,
    );
  });
  it('a policy decorator outside a tenant route is misplaced', async () => {
    expect(
      (await inventoryOf([RestoreCtl], [PolicyOutside])).join('\n'),
    ).toMatch(/v1\/elsewhere: permission decorator on a non-tenant route/);
  });
  it('without the restore route the app does not boot (the constant would silently drift)', async () => {
    expect((await inventoryOf([GoodCtl])).join('\n')).toMatch(
      /exactly one POST v1\/orgs\/:orgId\/restore handler, found 0/,
    );
  });
  it('G-8 does not apply to feature controllers (business mutations need no fresh session)', async () => {
    @Controller('v1/orgs/:orgId/feature')
    class FeatureWrite {
      @Post() @Fx.require('fx.read') create() {}
    }
    expect(await inventoryOf([RestoreCtl], [FeatureWrite])).toEqual([]);
  });
});
