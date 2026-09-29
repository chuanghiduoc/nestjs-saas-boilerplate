import { describe, expect, it } from 'vitest';
import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import {
  defineEvent,
  EventSubscriber,
  SubscriberRegistry,
} from '../../../../src/core/events/index.js';

const Pinged = defineEvent({
  type: 'unit.ping.sent',
  version: 1,
  audit: false,
  webhook: false,
  schema: z.object({}),
});

@Injectable()
@EventSubscriber({ consumer: 'unit.a', event: Pinged })
class A {
  async handle() {}
}
@Injectable()
@EventSubscriber({ consumer: 'unit.a', event: Pinged })
class ADuplicate {
  async handle() {}
}
@Injectable()
@EventSubscriber({ consumer: 'unit:bad', event: Pinged })
class BadName {
  async handle() {}
}
@Injectable()
@EventSubscriber({ consumer: 'unit.nohandle', event: Pinged })
class NoHandle {}

/** Chỉ cần DiscoveryService: registry được nạp trong onModuleInit. */
async function boot(providers: Type<unknown>[]): Promise<SubscriberRegistry> {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [SubscriberRegistry, ...providers],
  }).compile();
  try {
    await ref.init();
    return ref.get(SubscriberRegistry);
  } finally {
    await ref.close();
  }
}

describe('subscriber registry', () => {
  it('indexes subscribers by consumer and by type@version', async () => {
    const reg = await boot([A]);
    expect(reg.byConsumer('unit.a')?.meta.event).toBe(Pinged);
    expect(
      reg.forEvent('unit.ping.sent', 1).map((e) => e.meta.consumer),
    ).toEqual(['unit.a']);
    expect(reg.forEvent('unit.ping.sent', 2)).toEqual([]);
  });
  it('fails boot on duplicate consumer, invalid consumer name or missing handle()', async () => {
    await expect(boot([A, ADuplicate])).rejects.toThrow(
      /Duplicate subscriber consumer "unit\.a"/,
    );
    await expect(boot([BadName])).rejects.toThrow(
      /consumer "unit:bad" must match/,
    );
    await expect(boot([NoHandle])).rejects.toThrow(
      /must be a singleton provider implementing handle/,
    );
  });
});
