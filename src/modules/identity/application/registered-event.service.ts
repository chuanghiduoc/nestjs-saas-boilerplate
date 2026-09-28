import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { UserRegisteredEvent, registeredEventId } from '../events.js';
import { errorClass } from '../identity-telemetry.js';
import { RegistrationLedger } from '../ports/registration-ledger.js';

/**
 * SQLSTATE/code không PII của lỗi driver (pg, mikro-orm); không bao giờ đọc `.message` (có thể chứa
 * email). Một mức `cause` (lỗi bọc lại), giống `pgFields` của `db-error.mapper.ts`.
 */
const errorCode = (err: unknown): string | undefined => {
  const codeOf = (v: unknown): string | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const rec = v as { code?: unknown; sqlState?: unknown };
    return [rec.sqlState, rec.code].find(
      (c): c is string => typeof c === 'string',
    );
  };
  return (
    codeOf(err) ??
    codeOf(
      typeof err === 'object' && err !== null
        ? (err as { cause?: unknown }).cause
        : undefined,
    )
  );
};

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
    private readonly ctx: RequestContext,
  ) {}

  /**
   * Trong transaction của caller (cron gom cả batch vào một `uow.run`).
   * spec §5.10: event này luôn `orgId: null` (user chưa vào org nào). `EventPublisher` lấy org từ
   * `RequestContext` (không nhận override từ caller, theo thiết kế chống gắn nhầm org), nên ở đây chỉ còn
   * cách khẳng định bất biến: nếu có ngày một caller (vd. luồng invite-accept của SP3) gọi hàm này trong
   * một request có org, lỗi phải nổ ngay thay vì lặng lẽ gắn nhầm org cho event.
   */
  async publish(userId: string): Promise<void> {
    const orgId = this.ctx.orgId();
    if (orgId !== undefined) {
      throw new Error(
        `identity.user.registered must carry orgId: null (spec §5.10); refusing to publish for user ${userId} inside org context ${orgId}`,
      );
    }
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
          errorClass: errorClass(err),
          code: errorCode(err),
          userId,
          event: 'registered_event_deferred',
        },
        'identity.user.registered deferred to the reconcile cron',
      );
    }
  }
}
