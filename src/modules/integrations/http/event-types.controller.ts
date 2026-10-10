import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { WebhookEventCatalogueCheck } from '../application/event-catalogue-check.js';
import { EventTypeListResponse } from './schemas.js';

/** JSON Schema 2020-12, cùng dialect với OpenAPI 3.1 của `buildOpenApi`. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

/** Spec SP6 §8.3 "Hợp đồng công khai": catalog kèm JSON Schema của `data`. Cần principal (AuthGuard), không cần org. */
@Controller('v1/webhook-event-types')
export class EventTypesController {
  constructor(private readonly catalogue: WebhookEventCatalogueCheck) {}

  @Get()
  @ApiOk(EventTypeListResponse)
  list() {
    const data = this.catalogue.definitions().map((d) => ({
      type: d.type,
      version: d.version,
      schema: z.toJSONSchema(d.schema, {
        target: JSON_SCHEMA_TARGET,
        io: 'output',
      }),
    }));
    return serialize(EventTypeListResponse, { data });
  }
}
