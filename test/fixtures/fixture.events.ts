import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  defineEvent,
  EventSubscriber,
  type EventEnvelope,
} from '../../src/core/events/index.js';

export const NoteCreated = defineEvent({
  type: 'fixture.note.created',
  version: 1,
  schema: z.object({ body: z.string() }),
});
export const received: { consumer: string; body: string; eventId: string }[] =
  [];
export const failOnce = new Set<string>();

@Injectable()
@EventSubscriber({ consumer: 'fixture.audit', event: NoteCreated })
export class AuditSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) {
    received.push({
      consumer: 'fixture.audit',
      body: e.data.body,
      eventId: e.id,
    });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.mailer', event: NoteCreated })
export class MailerSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) {
    if (failOnce.delete(e.data.body)) throw new Error('mailer down');
    received.push({
      consumer: 'fixture.mailer',
      body: e.data.body,
      eventId: e.id,
    });
  }
}
