import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  etagOf,
  serialize,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { IdentityErrors, PlatformStaffAction } from '../../identity/index.js';
import type { AdminView } from '../application/admin-entitlements.query.js';
import { AdminEntitlements } from '../application/admin-entitlements.service.js';
import { EntitlementCatalogueRegistry } from '../application/entitlement-catalogue.registry.js';
import type { OverrideRequest } from '../domain/override.js';
import { EntitlementsErrors } from '../errors.js';
import {
  AdminOrgEntitlementsResponse,
  AdminPlansResponse,
  DeleteOverrideBody,
  PutOverrideBody,
  PutPlanBody,
  adminEntitlementsOf,
  adminPlansOf,
} from './schemas.js';

/** Mã của gate (addendum 3D §A1.3, do identity/tenancy trả): chỉ khai trong OpenAPI, 4C không định nghĩa mã nào. */
const GATE_PROBLEMS = [
  CoreErrors.UNAUTHENTICATED,
  CoreErrors.FORBIDDEN,
  IdentityErrors.SECOND_FACTOR_REQUIRED,
  IdentityErrors.REAUTHENTICATION_REQUIRED,
  IdentityErrors.API_KEY_NOT_ALLOWED_HERE,
  CoreErrors.SERVICE_UNAVAILABLE,
] as const;
const WRITE_PROBLEMS = [
  CoreErrors.NOT_FOUND,
  CoreErrors.PRECONDITION_REQUIRED,
  CoreErrors.PRECONDITION_FAILED,
  CoreErrors.VALIDATION_FAILED,
] as const;
/** Dữ liệu nội bộ của nhân viên (có `reason`): không lưu ở cache trình duyệt/proxy. */
const NO_STORE = 'no-store';
const OrgIdParam = z.uuid();
/** Id không phải UUID là "không có resource như vậy" (404), không phải `400 org_context_invalid` của `OrgScope`. */
const orgIdOrNotFound = (raw: string): string => {
  const r = OrgIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
/** Phần request mà controller đụng (không dùng kiểu của Express: luật `http-platform-only-in-core-http`). */
type ConditionalRequest = {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * API quản trị (spec §12.2, S4-D15): mọi route mang `@PlatformStaffAction()` của identity (3D) làm guard route-scoped duy
 * nhất; gate, step-up và audit truy cập là của 3D. Route không khớp `v1/orgs/:orgId` nên không qua `OrgContextMiddleware`;
 * service mở `OrgScope` không qua membership (S4-D19). Org API key bị `OrgApiKeyConfinementGuard` chặn (403).
 */
@Controller('v1/admin')
export class AdminEntitlementsController {
  constructor(
    private readonly admin: AdminEntitlements,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  @Get('plans')
  @PlatformStaffAction()
  @ApiOk(AdminPlansResponse)
  @ApiProblems(...GATE_PROBLEMS)
  plans(@Res({ passthrough: true }) res: HeaderWriter) {
    res.setHeader('Cache-Control', NO_STORE);
    return serialize(
      AdminPlansResponse,
      adminPlansOf(this.registry.plans(), this.registry.features()),
    );
  }

  /**
   * `ETag` = `version` để `If-Match` của lần ghi sau dùng được, nhưng KHÔNG `304` (review 4C Spec-I2): `status`/`source` của
   * override và usage đổi theo thời gian mà `version` không đổi. Express tự trả `304` khi `If-None-Match` khớp `ETag` của
   * response, nên header điều kiện bị gỡ trước khi trả: response luôn là biểu diễn hiện tại.
   */
  @Get('orgs/:orgId/entitlements')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(...GATE_PROBLEMS, CoreErrors.NOT_FOUND)
  async view(
    @Param('orgId') orgId: string,
    @Req() req: ConditionalRequest,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    return this.send(res, id, await this.admin.view(id));
  }

  @Put('orgs/:orgId/entitlements/plan')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(
    ...GATE_PROBLEMS,
    ...WRITE_PROBLEMS,
    EntitlementsErrors.PLAN_RETIRED,
    EntitlementsErrors.UNKNOWN_PLAN,
  )
  async putPlan(
    @Param('orgId') orgId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PutPlanBody }) body: z.infer<typeof PutPlanBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    return this.send(res, id, await this.admin.assignPlan(id, ifMatch, body));
  }

  @Put('orgs/:orgId/entitlements/overrides/:featureKey')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(...GATE_PROBLEMS, ...WRITE_PROBLEMS)
  async putOverride(
    @Param('orgId') orgId: string,
    @Param('featureKey') featureKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PutOverrideBody }) body: z.infer<typeof PutOverrideBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    const value: OverrideRequest =
      'enabled' in body ? { enabled: body.enabled } : { limit: body.limit };
    const view = await this.admin.setOverride(id, featureKey, ifMatch, {
      value,
      reason: body.reason,
      expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
    });
    return this.send(res, id, view);
  }

  @Delete('orgs/:orgId/entitlements/overrides/:featureKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PlatformStaffAction()
  @ApiProblems(...GATE_PROBLEMS, ...WRITE_PROBLEMS)
  async deleteOverride(
    @Param('orgId') orgId: string,
    @Param('featureKey') featureKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: DeleteOverrideBody })
    body: z.infer<typeof DeleteOverrideBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ): Promise<void> {
    const id = orgIdOrNotFound(orgId);
    const version = await this.admin.removeOverride(
      id,
      featureKey,
      body.reason,
      ifMatch,
    );
    res.setHeader('ETag', etagOf(version));
    res.setHeader('Cache-Control', NO_STORE);
  }

  private send(res: HeaderWriter, orgId: string, view: AdminView) {
    res.setHeader('ETag', etagOf(view.root.version));
    res.setHeader('Cache-Control', NO_STORE);
    return serialize(
      AdminOrgEntitlementsResponse,
      adminEntitlementsOf(orgId, view, this.registry.features()),
    );
  }
}
