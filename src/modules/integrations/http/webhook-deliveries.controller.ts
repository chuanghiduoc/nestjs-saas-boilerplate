import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  Paginator,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { DeliveryService } from '../application/delivery.service.js';
import { IntegrationsErrors } from '../errors.js';
import { WebhookPermissions } from '../permissions.js';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
} from './delivery-cursor.js';
import {
  DeliveryListQuery,
  RecoverBody,
  RecoverResponse,
  WebhookDeliveryPage,
  WebhookDeliveryResponse,
  deliveryOf,
  publicIdOrNotFound,
} from './schemas.js';

/** Spec SP6 §9.2 (dead-letter, gửi thử). `retry`, `recover`, `test` là `@Idempotent()`: response không chứa secret. */
@Controller('v1/orgs/:orgId')
export class WebhookDeliveriesController {
  constructor(
    private readonly deliveries: DeliveryService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
  ) {}

  @Get('webhook-endpoints/:endpointId/deliveries')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookDeliveryPage)
  @ApiProblems(CoreErrors.INVALID_CURSOR, CoreErrors.NOT_FOUND)
  async list(
    @Param('endpointId') endpointId: string,
    @Query({ schema: DeliveryListQuery }) q: z.infer<typeof DeliveryListQuery>,
  ) {
    const after =
      q.cursor === undefined ? undefined : decodeDeliveryCursor(q.cursor);
    const { rows, hasMore } = await this.deliveries.list(
      publicIdOrNotFound(endpointId),
      { status: q.status, limit: q.limit, after },
    );
    const last = rows.at(-1);
    return this.pages.cursor(
      rows.map((v) => serialize(WebhookDeliveryResponse, deliveryOf(v))),
      {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeDeliveryCursor({
                createdAt: last.createdAtKey,
                publicId: last.publicId,
              })
            : null,
      },
    );
  }

  @Post('webhook-endpoints/:endpointId/recover')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(RecoverResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED,
    CoreErrors.NOT_FOUND,
    CoreErrors.VALIDATION_FAILED,
  )
  async recover(
    @Param('endpointId') endpointId: string,
    @Body({ schema: RecoverBody }) body: z.infer<typeof RecoverBody>,
  ) {
    return serialize(
      RecoverResponse,
      await this.deliveries.recover(publicIdOrNotFound(endpointId), body.since),
    );
  }

  @Post('webhook-endpoints/:endpointId/test')
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED,
    CoreErrors.NOT_FOUND,
  )
  async test(
    @Param('endpointId') endpointId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const v = await this.deliveries.sendTest(publicIdOrNotFound(endpointId));
    setLocation(
      res,
      `/v1/orgs/${this.orgId()}/webhook-deliveries/${v.publicId}`,
    );
    return serialize(WebhookDeliveryResponse, deliveryOf(v));
  }

  @Get('webhook-deliveries/:deliveryId')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(CoreErrors.NOT_FOUND)
  async get(@Param('deliveryId') deliveryId: string) {
    return serialize(
      WebhookDeliveryResponse,
      deliveryOf(await this.deliveries.get(publicIdOrNotFound(deliveryId))),
    );
  }

  @Post('webhook-deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_DELIVERY_NOT_RETRYABLE,
    IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED,
    CoreErrors.NOT_FOUND,
  )
  async retry(@Param('deliveryId') deliveryId: string) {
    return serialize(
      WebhookDeliveryResponse,
      deliveryOf(await this.deliveries.retry(publicIdOrNotFound(deliveryId))),
    );
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined)
      throw new Error('WebhookDeliveriesController ran without an org context');
    return id;
  }
}
