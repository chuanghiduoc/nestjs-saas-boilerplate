import { Logger } from '@nestjs/common';
import { runWithRequestState } from '@better-auth/core/context';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { createStaffCredentialFence } from '../../../src/modules/identity/infra/better-auth/staff-credential-fence.js';
import { StaffStepUp } from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

describe('pre-write password guard (spec SP3 §9.7 (7), N7-4, R8-S1)', () => {
  let pool: pg.Pool;
  const state = new AuthRequestState();
  let fence: ReturnType<typeof createStaffCredentialFence>;
  const staffWithoutFactor = async () =>
    (
      await ownerQuery<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
      VALUES ('W', $1, true, 'admin', now(), now(), now()) RETURNING id`,
        [`w-${randomUUID()}@example.test`],
      )
    )[0]!.id;
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    fence = createStaffCredentialFence({
      pool,
      stepUp: new StaffStepUp(pool),
      state,
      logger: new Logger('fence-test'),
    });
  });
  afterAll(async () => pool?.end());

  it.each(['/reset-password', '/change-password', '/admin/set-user-password'])(
    '%s: a password write without subjects in the request state → 500 PASSWORD_WRITE_SUBJECT_UNRESOLVED + ERROR (fail closed)',
    async (path) => {
      const errors = vi.spyOn(Logger.prototype, 'error');
      await expect(
        runWithRequestState(new WeakMap(), () =>
          fence.passwordWriteBefore({ password: 'h' }, { path }),
        ),
      ).rejects.toMatchObject({
        statusCode: 500,
        body: { code: 'PASSWORD_WRITE_SUBJECT_UNRESOLVED' },
      });
      expect(
        errors.mock.calls.some(
          ([o]) =>
            typeof o === 'object' &&
            o !== null &&
            'event' in o &&
            o.event === 'password_write_subject_unresolved',
        ),
      ).toBe(true);
      errors.mockRestore();
    },
  );
  it('create.before with a userId outside the recorded subjects → 500', async () => {
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([randomUUID()]);
        await fence.passwordWriteBefore(
          { password: 'h', userId: randomUUID(), providerId: 'credential' },
          { path: '/reset-password' },
        );
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
  it.each([
    ['/reset-password', 400, 'INVALID_TOKEN'],
    ['/change-password', 403, 'SECOND_FACTOR_REQUIRED'],
    ['/admin/set-user-password', 403, 'STAFF_PASSWORD_WRITE_FORBIDDEN'],
  ])(
    '%s: a recorded subject that is staff without a factor → %i %s (stage write), factors recorded otherwise',
    async (path, status, code) => {
      const staff = await staffWithoutFactor();
      await expect(
        runWithRequestState(new WeakMap(), async () => {
          await state.setPasswordWriteSubjects([staff]);
          await fence.passwordWriteBefore({ password: 'h' }, { path });
        }),
      ).rejects.toMatchObject({ statusCode: status, body: { code } });
      const regular = (
        await ownerQuery<{ id: string }>(
          `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at) VALUES ('R', $1, true, now(), now(), now()) RETURNING id`,
          [`r-${randomUUID()}@example.test`],
        )
      )[0]!.id;
      const factors = await runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([regular]);
        await fence.passwordWriteBefore({ password: 'h' }, { path });
        return state.writeFactors();
      });
      expect([...factors]).toEqual([[regular, null]]);
    },
  );
  it('writes on other paths or without a password field are ignored', async () => {
    await expect(
      runWithRequestState(new WeakMap(), () =>
        fence.passwordWriteBefore(
          { accessToken: 'x' },
          { path: '/change-password' },
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      runWithRequestState(new WeakMap(), () =>
        fence.passwordWriteBefore({ password: 'h' }, { path: '/callback/:id' }),
      ),
    ).resolves.toBeUndefined();
  });
});
