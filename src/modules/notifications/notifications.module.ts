import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type ConfigOf } from '../../core/config/index.js';
import { ResilienceModule } from '../../core/resilience/index.js';
import { SecurityModule } from '../../core/security/index.js';
import { PurgeDeliveriesHandler } from './application/purge-deliveries.handler.js';
import { ReconcileDeliveriesHandler } from './application/reconcile-deliveries.handler.js';
import { RequestEmailService } from './application/request-email.service.js';
import { SendEmailHandler } from './application/send-email.handler.js';
import {
  MjmlHandlebarsRenderer,
  NOTIFICATION_RENDER_OPTIONS,
  NOTIFICATION_TEMPLATES_DIR,
  defaultTemplatesDir,
} from './infra/mjml-handlebars.renderer.js';
import { NodemailerTransport } from './infra/nodemailer.transport.js';
import { SqlDeliveryRepository } from './infra/sql-delivery.repository.js';
import { notificationsConfig } from './notifications.config.js';
import { DeliveryRepository } from './ports/delivery-repository.js';
import { EmailNotifications } from './ports/email-notifications.js';
import { MailTransport } from './ports/mail-transport.js';
import { TemplateRenderer } from './ports/template-renderer.js';
import './jobs.js';
import './events.js';

const shared: Provider[] = [
  SqlDeliveryRepository,
  { provide: DeliveryRepository, useExisting: SqlDeliveryRepository },
  RequestEmailService,
  { provide: EmailNotifications, useExisting: RequestEmailService },
];

/** `forApi`: chỉ ghi DB + enqueue. `forWorker`: thêm renderer, SMTP, handler gửi thư, và cron đối soát/dọn. */
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

  static forWorker(): DynamicModule {
    return {
      module: NotificationsModule,
      global: true,
      imports: [SecurityModule, ResilienceModule],
      providers: [
        ...shared,
        {
          provide: NOTIFICATION_TEMPLATES_DIR,
          useFactory: defaultTemplatesDir,
        },
        {
          provide: NOTIFICATION_RENDER_OPTIONS,
          inject: [notificationsConfig.KEY],
          useFactory: (c: ConfigOf<typeof notificationsConfig>) => ({
            defaultLocale: c.defaultLocale,
          }),
        },
        MjmlHandlebarsRenderer,
        { provide: TemplateRenderer, useExisting: MjmlHandlebarsRenderer },
        NodemailerTransport,
        { provide: MailTransport, useExisting: NodemailerTransport },
        SendEmailHandler,
        ReconcileDeliveriesHandler,
        PurgeDeliveriesHandler,
      ],
      exports: [EmailNotifications],
    };
  }
}
