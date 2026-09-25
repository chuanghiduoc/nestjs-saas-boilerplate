import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  DeliverEventHandler,
  DispatchEventHandler,
  OutboxReader,
  SubscriberRegistry,
} from './event-dispatch.handlers.js';
import { EventPublisher } from './event-publisher.js';

/**
 * `worker: true` chỉ trong worker: handler dispatch/deliver đọc outbox bằng `RelayDb` (cần
 * `DatabaseModule.forRoot({ relay: true })`). API chỉ phát event.
 */
@Global()
@Module({})
export class EventsModule {
  static forRoot(opts: { worker: boolean }): DynamicModule {
    return {
      module: EventsModule,
      imports: [DiscoveryModule],
      providers: [
        EventPublisher,
        ...(opts.worker
          ? [
              SubscriberRegistry,
              OutboxReader,
              DispatchEventHandler,
              DeliverEventHandler,
            ]
          : []),
      ],
      exports: [EventPublisher],
    };
  }
}
