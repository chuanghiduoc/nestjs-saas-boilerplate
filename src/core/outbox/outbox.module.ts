import { type DynamicModule, Global, Module } from '@nestjs/common';
import { Inbox } from './inbox.js';
import { OutboxCleanupHandler } from './outbox-cleanup.handler.js';
import { OUTBOX_RELAY_HOOKS, OutboxRelay } from './outbox.relay.js';
import { OutboxWriter } from './outbox.writer.js';
import { SafeEnqueue } from './safe-enqueue.js';

/** `relay: true` chỉ trong worker (cần `DatabaseModule.forRoot({ relay: true })` cho `RelayDb`). */
@Global()
@Module({})
export class OutboxModule {
  static forRoot(opts: { relay: boolean }): DynamicModule {
    const relay = opts.relay
      ? [
          OutboxRelay,
          OutboxCleanupHandler,
          { provide: OUTBOX_RELAY_HOOKS, useValue: {} },
        ]
      : [];
    return {
      module: OutboxModule,
      providers: [OutboxWriter, Inbox, SafeEnqueue, ...relay],
      exports: [
        OutboxWriter,
        Inbox,
        SafeEnqueue,
        ...(opts.relay
          ? [OutboxRelay, OutboxCleanupHandler, OUTBOX_RELAY_HOOKS]
          : []),
      ],
    };
  }
}
