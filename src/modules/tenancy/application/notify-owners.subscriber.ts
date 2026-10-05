import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import {
  EventSubscriber,
  type EventEnvelope,
  type EventHandler,
} from '../../../core/events/index.js';
import { IdentityDirectory, identityConfig } from '../../identity/index.js';
import {
  DISPLAY_NAME_MAX,
  EmailNotifications,
} from '../../notifications/index.js';
import { oneLine } from '../domain/display-text.js';
import {
  SupportAccessGrantedEvent,
  SupportAccessRevokedEvent,
  SupportAccessUsedEvent,
} from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';

type Kind = 'granted' | 'used' | 'revoked';
type SupportData = z.infer<typeof SupportAccessGrantedEvent.schema>;

/**
 * Spec SP3 §9.7 "Thông báo owner": một thư cho MỖI owner, trong Inbox + UnitOfWork + OrgScope của event (worker). Ngoại lệ có
 * tên của luật "không I/O ngoài trong transaction": `IdentityDirectory.findUsers` chạy trên pool `auth_user` (pool khác, không
 * tự khoá; deadline `DB_AUTH_QUERY_TIMEOUT_MS`). Thư đi qua outbox của notifications cùng transaction; idempotency key
 * `support-access-notice:<eventId>:<ownerMemberPublicId>` nên chạy lại không gửi trùng.
 */
@Injectable()
export class OwnerNotifier {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly emails: EmailNotifications,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async notify(e: EventEnvelope<SupportData>, kind: Kind): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== e.orgId)
      throw new Error(
        'tenancy.notify-owners must run in the UnitOfWork and OrgScope of the event organization',
      );
    // Support grant chỉ bật ở local/hybrid (Task 16); event tới đây ở external là lỗi lắp ráp.
    if (this.identity.mode === 'external' || !this.directory)
      throw new Error(
        'tenancy.notify-owners needs IdentityDirectory (support grants are off in external mode)',
      );
    const org = await this.orgs.readCurrent();
    if (!org) return; // org đã purge trước khi event tới: không còn ai để báo
    const owners = (await this.members.owners()).flatMap((m) =>
      m.authUserId === null ? [] : [{ member: m, authUserId: m.authUserId }],
    );
    const batch = this.identity.directoryBatchMax;
    for (let i = 0; i < owners.length; i += batch) {
      const page = owners.slice(i, i + batch);
      const users = new Map(
        (await this.directory.findUsers(page.map((o) => o.authUserId))).map(
          (u) => [u.id, u],
        ),
      );
      for (const { member, authUserId } of page) {
        const u = users.get(authUserId);
        if (!u) continue; // tài khoản owner vừa bị xoá: không còn địa chỉ
        await this.emails.request({
          template: 'support-access-notice',
          to: u.email,
          params: {
            name: oneLine(u.name, DISPLAY_NAME_MAX),
            orgName: oneLine(org.name, DISPLAY_NAME_MAX),
            kind,
            expiresAt: e.data.expiresAt,
          },
          idempotencyKey: `support-access-notice:${e.id}:${member.publicId}`,
        });
      }
    }
  }
}

/** Một consumer mỗi event: `@EventSubscriber` nhận đúng một `type@version`. */
@Injectable()
@EventSubscriber({
  consumer: 'tenancy.notify-owners.granted',
  event: SupportAccessGrantedEvent,
})
export class NotifyOwnersOnGranted implements EventHandler<
  typeof SupportAccessGrantedEvent
> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle(
    e: EventEnvelope<z.infer<typeof SupportAccessGrantedEvent.schema>>,
  ): Promise<void> {
    return this.notifier.notify(e, 'granted');
  }
}

@Injectable()
@EventSubscriber({
  consumer: 'tenancy.notify-owners.used',
  event: SupportAccessUsedEvent,
})
export class NotifyOwnersOnUsed implements EventHandler<
  typeof SupportAccessUsedEvent
> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle(
    e: EventEnvelope<z.infer<typeof SupportAccessUsedEvent.schema>>,
  ): Promise<void> {
    return this.notifier.notify(e, 'used');
  }
}

@Injectable()
@EventSubscriber({
  consumer: 'tenancy.notify-owners.revoked',
  event: SupportAccessRevokedEvent,
})
export class NotifyOwnersOnRevoked implements EventHandler<
  typeof SupportAccessRevokedEvent
> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle(
    e: EventEnvelope<z.infer<typeof SupportAccessRevokedEvent.schema>>,
  ): Promise<void> {
    return this.notifier.notify(e, 'revoked');
  }
}
