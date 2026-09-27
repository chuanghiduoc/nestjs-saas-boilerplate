import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { EventPublisher } from '../../../../src/core/events/index.js';
import { RegisteredEventService } from '../../../../src/modules/identity/application/registered-event.service.js';
import { ReconcileRegisteredHandler } from '../../../../src/modules/identity/application/reconcile-registered.handler.js';
import { PurgeExpiredHandler } from '../../../../src/modules/identity/application/purge-expired.handler.js';
import { identityGuardConfig } from '../../../../src/modules/identity/identity.config.js';
import { RegistrationLedger } from '../../../../src/modules/identity/ports/registration-ledger.js';
import { v5 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_EVENT_NAMESPACE,
  registeredEventId,
} from '../../../../src/modules/identity/events.js';

describe('identity.user.registered event id (D10, spec §5.10)', () => {
  it('namespace is v5("nestjs-saas-boilerplate/identity-events", v5.URL)', () => {
    expect(v5('nestjs-saas-boilerplate/identity-events', v5.URL)).toBe(
      IDENTITY_EVENT_NAMESPACE,
    );
  });
  it('matches the fixed test vector', () => {
    expect(registeredEventId('019dd1a5-9235-70db-8d57-54ef901d8185')).toBe(
      '59f229d2-931e-5ad8-8c7c-5ee7dbfd34e4',
    );
  });
});

const USER_ID = '019dd1a5-9235-70db-8d57-54ef901d8185';
const ctx = () => ({
  payload: {},
  meta: {},
  jobId: USER_ID,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
const uow: UnitOfWork = {
  run: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  inTransaction: () => true,
};

afterEach(() => vi.restoreAllMocks());

describe('registered event failure recovery and external mode', () => {
  it('external mode resolves handlers without auth providers and logs safe no-ops', async () => {
    const debug = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => {});
    const module = await Test.createTestingModule({
      providers: [
        ReconcileRegisteredHandler,
        PurgeExpiredHandler,
        { provide: UnitOfWork, useValue: uow },
        {
          provide: identityGuardConfig.KEY,
          useValue: identityGuardConfig.schema.parse({}),
        },
      ],
    }).compile();
    try {
      await expect(
        module.get(ReconcileRegisteredHandler).handle(ctx()),
      ).resolves.toEqual({ published: 0 });
      await expect(
        module.get(PurgeExpiredHandler).handle(ctx()),
      ).resolves.toEqual({});
      expect(debug).toHaveBeenCalledTimes(2);
    } finally {
      await module.close();
    }
  });

  it.each(['outbox', 'marker'])(
    'defers %s failures without exposing email or error message',
    async (step) => {
      const error = new Error('private-email@example.test');
      const publish = vi.fn().mockResolvedValue(registeredEventId(USER_ID));
      const mark = vi.fn().mockResolvedValue(1);
      if (step === 'outbox') publish.mockRejectedValueOnce(error);
      else mark.mockRejectedValueOnce(error);
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      const module = await Test.createTestingModule({
        providers: [
          RegisteredEventService,
          { provide: UnitOfWork, useValue: uow },
          { provide: EventPublisher, useValue: { publish } },
          { provide: RegistrationLedger, useValue: { mark } },
        ],
      }).compile();
      try {
        await expect(
          module.get(RegisteredEventService).onUserCreated(USER_ID),
        ).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: USER_ID,
            errorClass: 'Error',
            event: 'registered_event_deferred',
          }),
          expect.any(String),
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
        expect(mark).toHaveBeenCalledTimes(step === 'outbox' ? 0 : 1);
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'identity.user.registered' }),
          expect.objectContaining({
            eventId: registeredEventId(USER_ID),
            data: { userId: USER_ID },
          }),
          { ifAbsent: true },
        );
      } finally {
        await module.close();
      }
    },
  );
});
