import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { SecurityModule } from '../../core/security/index.js';
import { RequestEmailService } from './application/request-email.service.js';
import { SqlDeliveryRepository } from './infra/sql-delivery.repository.js';
import { DeliveryRepository } from './ports/delivery-repository.js';
import { EmailNotifications } from './ports/email-notifications.js';
import './jobs.js';
import './events.js';

const shared: Provider[] = [
  SqlDeliveryRepository,
  { provide: DeliveryRepository, useExisting: SqlDeliveryRepository },
  RequestEmailService,
  { provide: EmailNotifications, useExisting: RequestEmailService },
];

/** `forApi`: chỉ ghi DB + enqueue. `forWorker` (Task 24): thêm renderer, SMTP, handler và cron. */
@Module({})
export class NotificationsModule {
  static forApi(): DynamicModule {
    return {
      module: NotificationsModule,
      global: true,
      imports: [SecurityModule],
      providers: shared,
      exports: [EmailNotifications],
    };
  }
}
