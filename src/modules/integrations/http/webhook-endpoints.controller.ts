import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Paginator,
  etagOf,
  paginationConfig,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import {
  IdentityErrors,
  RequireFreshSession,
  RequireVerifiedEmail,
  SessionOnly,
} from '../../identity/index.js';
import { EndpointService } from '../application/endpoint.service.js';
import { IntegrationsErrors } from '../errors.js';
import { WebhookPermissions } from '../permissions.js';
import {
  CreateEndpointBody,
  CreatedWebhookEndpointResponse,
  EndpointListPage,
  PatchEndpointBody,
  PatchEndpointDestinationBody,
  RotatedSecretResponse,
  WebhookEndpointPage,
  WebhookEndpointResponse,
  endpointOf,
  publicIdOrNotFound,
} from './schemas.js';

/** Spec SP6 §9.2. Org từ path qua pipeline SP3 §7 (OrgScope mở sẵn). */
@Controller('v1/orgs/:orgId/webhook-endpoints')
export class WebhookEndpointsController {
  constructor(
    private readonly endpoints: EndpointService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  /** Không `@Idempotent()`: body trả secret và idempotency lưu body vào Redis (S3-A8). Session mới (S6-A35). */
  @Post()
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(CreatedWebhookEndpointResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED,
    IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
    IntegrationsErrors.WEBHOOK_ENDPOINTS_LIMIT,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateEndpointBody })
    body: z.infer<typeof CreateEndpointBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const { endpoint, secret } = await this.endpoints.create(body);
    setLocation(
      res,
      `/v1/orgs/${this.orgId()}/webhook-endpoints/${endpoint.publicId}`,
    );
    res.setHeader('ETag', etagOf(endpoint.version));
    // Secret một lần: không cache ở proxy/trình duyệt.
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedWebhookEndpointResponse, {
      ...endpointOf(endpoint),
      secret,
    });
  }

  @Get()
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookEndpointPage)
  async list(
    @Query({ schema: EndpointListPage }) page: z.infer<typeof EndpointListPage>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.endpoints.list({
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((r) => serialize(WebhookEndpointResponse, endpointOf(r))),
      page,
      total,
    );
  }

  @Get(':endpointId')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(CoreErrors.NOT_FOUND)
  async get(
    @Param('endpointId') endpointId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const row = await this.endpoints.get(publicIdOrNotFound(endpointId));
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  /** Mô tả và trạng thái: quyền thường (session cũ, API key của user đều được). */
  @Patch(':endpointId')
  @WebhookPermissions.require('webhooks.write')
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(
    CoreErrors.VALIDATION_FAILED,
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
    CoreErrors.NOT_FOUND,
  )
  async update(
    @Param('endpointId') endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchEndpointBody })
    body: z.infer<typeof PatchEndpointBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const row = await this.endpoints.update(
      publicIdOrNotFound(endpointId),
      ifMatch,
      { description: body.description, status: body.status },
    );
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  /** R-X34: đổi đích = tạo mới — session của người, mới, email đã xác thực (S6-A35), như `POST`. */
  @Patch(':endpointId/destination')
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED,
    IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    CoreErrors.VALIDATION_FAILED,
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
    CoreErrors.NOT_FOUND,
  )
  async updateDestination(
    @Param('endpointId') endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchEndpointDestinationBody })
    body: z.infer<typeof PatchEndpointDestinationBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const row = await this.endpoints.update(
      publicIdOrNotFound(endpointId),
      ifMatch,
      { url: body.url, eventTypes: body.eventTypes },
    );
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  @Delete(':endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WebhookPermissions.require('webhooks.write')
  @ApiProblems(CoreErrors.PRECONDITION_FAILED, CoreErrors.NOT_FOUND)
  async remove(
    @Param('endpointId') endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.endpoints.remove(publicIdOrNotFound(endpointId), ifMatch);
  }

  /** Không `@Idempotent()` (trả secret). Session mới như lúc tạo (S6-A35). */
  @Post(':endpointId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(RotatedSecretResponse)
  @ApiProblems(IdentityErrors.REAUTHENTICATION_REQUIRED, CoreErrors.NOT_FOUND)
  async rotateSecret(
    @Param('endpointId') endpointId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const r = await this.endpoints.rotateSecret(publicIdOrNotFound(endpointId));
    res.setHeader('Cache-Control', 'no-store');
    return serialize(RotatedSecretResponse, {
      secret: r.secret,
      previousExpiresAt: r.previousExpiresAt?.toISOString() ?? null,
    });
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined)
      throw new Error('WebhookEndpointsController ran without an org context');
    return id;
  }
}
