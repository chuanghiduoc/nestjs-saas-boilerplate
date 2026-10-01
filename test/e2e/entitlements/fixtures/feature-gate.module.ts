import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Post,
} from '@nestjs/common';
import { RequestContext } from '../../../../src/core/context/index.js';
import { Db } from '../../../../src/core/database/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';
import { FixtureFeatures } from '../../../support/entitlements-fixtures.js';

let created = 0;
export const createdCount = (): number => created;

/** Route tenant giả của `features/` (ngoài module tenancy nên không vào luật G-8): quan sát context sau khi qua cổng. */
@Controller('v1/orgs/:orgId/fx')
export class FeatureGateController {
  constructor(
    private readonly ctx: RequestContext,
    private readonly db: Db,
  ) {}

  private async observe() {
    const [row] = await this.db.execute<{ org: string }>(
      'SELECT app_current_org()::text AS org',
    );
    return { orgId: this.ctx.orgId(), sqlOrg: row?.org ?? null };
  }

  @Get('guard-first')
  @TenancyPermissions.require('org.delete')
  @FixtureFeatures.requireEnabled('fixture.reports')
  guardFirst() {
    return this.observe();
  }

  @Get('feature-first')
  @FixtureFeatures.requireEnabled('fixture.reports')
  @TenancyPermissions.require('org.delete')
  featureFirst() {
    return this.observe();
  }

  @Post('idem-a')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @FixtureFeatures.requireEnabled('fixture.reports')
  @Idempotent()
  idemA() {
    created += 1;
    return { n: created };
  }

  @Post('idem-b')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @Idempotent()
  @FixtureFeatures.requireEnabled('fixture.reports')
  idemB() {
    created += 1;
    return { n: created };
  }
}

/** Cổng ở class (`fixture.exports`) cộng cổng ở method (`fixture.reports`): cả hai phải bật (Review Focus 5). */
@Controller('v1/orgs/:orgId/fx-class')
@FixtureFeatures.requireEnabled('fixture.exports')
class ClassGateController {
  @Get()
  @TenancyPermissions.require('org.read')
  @FixtureFeatures.requireEnabled('fixture.reports')
  both() {
    return { ok: true };
  }
}

@Module({ controllers: [FeatureGateController, ClassGateController] })
export class FeatureGateModule {}
