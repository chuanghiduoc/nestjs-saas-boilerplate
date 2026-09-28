import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { EventPublisher } from '../../../../src/core/events/index.js';
import { SafeEnqueue } from '../../../../src/core/outbox/index.js';
import { ReconcileDeliveriesHandler } from '../../../../src/modules/notifications/application/reconcile-deliveries.handler.js';
import { notificationsConfig } from '../../../../src/modules/notifications/notifications.config.js';
import { DeliveryRepository } from '../../../../src/modules/notifications/ports/delivery-repository.js';

const MAX_ATTEMPTS = 3;
const id = '0199aaaa-0000-7000-8000-000000000002';

async function fixture() {
  const repo = {
    findStale: vi.fn().mockResolvedValue([]),
    failExhausted: vi.fn().mockResolvedValue(undefined),
    bumpGeneration: vi.fn().mockResolvedValue(undefined),
  };
  const enqueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const events = { publish: vi.fn().mockResolvedValue(id) };
  const module = await Test.createTestingModule({
    providers: [
      ReconcileDeliveriesHandler,
      { provide: DeliveryRepository, useValue: repo },
      {
        provide: UnitOfWork,
        useValue: { run: <T>(fn: () => Promise<T>) => fn() },
      },
      { provide: SafeEnqueue, useValue: enqueue },
      { provide: EventPublisher, useValue: events },
      {
        provide: notificationsConfig.KEY,
        useValue: notificationsConfig.schema.parse({
          maxTotalAttempts: MAX_ATTEMPTS,
        }),
      },
    ],
  }).compile();
  const ctx = {
    payload: {},
    meta: {},
    jobId: id,
    attempt: 1,
    maxAttempts: 1,
    signal: new AbortController().signal,
    log: new Logger('test'),
  };
  return {
    module,
    handler: module.get(ReconcileDeliveriesHandler),
    repo,
    enqueue,
    events,
    ctx,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('ReconcileDeliveriesHandler', () => {
  it('requeues a row under the cap with the generation bumpGeneration returned', async () => {
    const f = await fixture();
    try {
      f.repo.findStale.mockResolvedValue([{ publicId: id, attempts: 0 }]);
      f.repo.bumpGeneration.mockResolvedValue(1);
      const result = await f.handler.handle(f.ctx);
      expect(result).toEqual({ requeued: 1, failed: 0 });
      expect(f.enqueue.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        { deliveryId: id },
        { jobId: `${id}-g1` },
      );
      expect(f.repo.failExhausted).not.toHaveBeenCalled();
      expect(f.events.publish).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });

  it('fails a row whose snapshot already reached maxAttempts, without ever calling bumpGeneration', async () => {
    const f = await fixture();
    try {
      f.repo.findStale.mockResolvedValue([
        { publicId: id, attempts: MAX_ATTEMPTS },
      ]);
      f.repo.failExhausted.mockResolvedValue('verify-email');
      const result = await f.handler.handle(f.ctx);
      expect(result).toEqual({ requeued: 0, failed: 1 });
      expect(f.repo.bumpGeneration).not.toHaveBeenCalled();
      expect(f.enqueue.enqueue).not.toHaveBeenCalled();
      expect(f.events.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: {
            deliveryId: id,
            template: 'verify-email',
            errorCode: 'ATTEMPTS_EXHAUSTED',
          },
        }),
      );
    } finally {
      await f.module.close();
    }
  });

  it('falls back to failExhausted when bumpGeneration returns 0 rows despite a snapshot under the cap (attempts advanced concurrently — FB: bounded overshoot)', async () => {
    const f = await fixture();
    try {
      // Snapshot from findStale says attempts = MAX_ATTEMPTS - 1 (still under the cap), but by the time
      // bumpGeneration's fenced UPDATE runs, another job has already pushed attempts to the cap (its own
      // `attempts < maxAttempts` guard trips) — this is exactly the race the reviewer flagged: without an
      // explicit fallback the row would never be re-enqueued NOR failed, and would stay stuck forever.
      f.repo.findStale.mockResolvedValue([
        { publicId: id, attempts: MAX_ATTEMPTS - 1 },
      ]);
      f.repo.bumpGeneration.mockResolvedValue(undefined);
      f.repo.failExhausted.mockResolvedValue('verify-email');
      const result = await f.handler.handle(f.ctx);
      expect(result).toEqual({ requeued: 0, failed: 1 });
      expect(f.enqueue.enqueue).not.toHaveBeenCalled();
      expect(f.repo.failExhausted).toHaveBeenCalledWith(id, MAX_ATTEMPTS);
      expect(f.events.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: {
            deliveryId: id,
            template: 'verify-email',
            errorCode: 'ATTEMPTS_EXHAUSTED',
          },
        }),
      );
    } finally {
      await f.module.close();
    }
  });

  it('does nothing when bumpGeneration returns 0 rows and the row is not (or no longer) exhausted either', async () => {
    const f = await fixture();
    try {
      // e.g. the cooldown had not elapsed yet, or another worker already moved the row to a final state.
      f.repo.findStale.mockResolvedValue([
        { publicId: id, attempts: MAX_ATTEMPTS - 1 },
      ]);
      f.repo.bumpGeneration.mockResolvedValue(undefined);
      f.repo.failExhausted.mockResolvedValue(undefined);
      const result = await f.handler.handle(f.ctx);
      expect(result).toEqual({ requeued: 0, failed: 0 });
      expect(f.enqueue.enqueue).not.toHaveBeenCalled();
      expect(f.events.publish).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
});
