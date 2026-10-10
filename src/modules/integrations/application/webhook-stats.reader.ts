import { Injectable } from '@nestjs/common';
import { WebhookStatsReader } from '../../../core/contracts/admin-readers.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';

/** Bản cài token của `core/contracts` (R-X16, S6-A52): admin inject `@Optional()`, không import `integrations/index.ts`. */
@Injectable()
export class SqlWebhookStatsReader extends WebhookStatsReader {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly endpoints: EndpointRepository,
  ) {
    super();
  }
  endpointCount(): Promise<number> {
    return this.uow.run(() => this.endpoints.countLive());
  }
}
