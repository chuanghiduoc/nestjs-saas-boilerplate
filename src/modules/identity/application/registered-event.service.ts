import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { UserRegisteredEvent, registeredEventId } from '../events.js';
import { RegistrationLedger } from '../ports/registration-ledger.js';

/**
 * Hai pool khác nhau (outbox trên `app_user`, marker trên `auth_user`) nên không gộp được một transaction
 * (D10). Thứ tự luôn là ghi outbox (commit) RỒI đặt marker; crash giữa hai bước chỉ dẫn tới ghi lại cùng id.
 */
@Injectable()
export class RegisteredEventService {
  private readonly logger = new Logger(RegisteredEventService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly events: EventPublisher,
    private readonly ledger: RegistrationLedger,
  ) {}

  /** Trong transaction của caller (cron gom cả batch vào một `uow.run`). */
  async publish(userId: string): Promise<void> {
    await this.events.publish(
      UserRegisteredEvent,
      {
        eventId: registeredEventId(userId),
        data: { userId },
        aggregate: { type: 'user', id: userId, version: 1 },
        actor: { type: 'user', id: userId },
      },
      { ifAbsent: true },
    );
  }

  /** `databaseHooks.user.create.after` (chạy sau commit của auth). Lỗi: log không PII rồi để cron bù (spec §5.10). */
  async onUserCreated(userId: string): Promise<void> {
    try {
      await this.uow.run(() => this.publish(userId));
      await this.ledger.mark([userId]);
    } catch (err) {
      this.logger.error(
        {
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
          userId,
          event: 'registered_event_deferred',
        },
        'identity.user.registered deferred to the reconcile cron',
      );
    }
  }
}
