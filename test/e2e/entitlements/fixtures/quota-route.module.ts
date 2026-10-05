import {
  Controller,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { Quotas } from '../../../../src/modules/entitlements/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

/**
 * Route tenant giả của một feature (ngoài module tenancy nên không vào luật G-8): tạo một "báo cáo đã lưu" tính quota kỳ
 * NONE, consume và INSERT trong CÙNG `UnitOfWork` (README "consume cùng transaction với side effect", spec §9.2).
 * `?fail=1`: side effect hỏng SAU consume → rollback cả hai.
 */
@Controller('v1/orgs/:orgId/fx-quota')
export class QuotaRouteController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly quotas: Quotas,
  ) {}

  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @Idempotent()
  create(@Query('fail') fail?: string) {
    return this.uow.run(async () => {
      const receipt = await this.quotas.consumeOrThrow(
        'fixture.saved_reports',
        1,
      );
      await this.db.execute(
        `INSERT INTO fixture_org_items (org_id, body) VALUES (app_current_org(), ?)`,
        [receipt.featureKey],
      );
      if (fail === '1')
        throw new Error('fixture side effect failed after the consume');
      return { amount: receipt.amount };
    });
  }
}

@Module({ controllers: [QuotaRouteController] })
export class QuotaRouteModule {}
