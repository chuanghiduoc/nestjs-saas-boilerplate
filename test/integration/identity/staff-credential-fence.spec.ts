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
import { seedStaffFactor } from '../../support/seed-staff-step-up.js';

const isEvent = (o: unknown, event: string): boolean =>
  typeof o === 'object' && o !== null && 'event' in o && o.event === event;

describe('post-write fence (9)(iv) and session cost (spec SP3 §9.7 (9), T-42, R8-S5)', () => {
  let pool: pg.Pool;
  const state = new AuthRequestState();
  let fence: ReturnType<typeof createStaffCredentialFence>;
  /** Admin + two_factor verified + cờ, account credential + google, một API key, hai session. */
  const staffWithFactorAndCredentials = async (): Promise<string> => {
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
       VALUES ('F', $1, true, 'admin', now(), now(), now()) RETURNING id`,
      [`f-${randomUUID()}@example.test`],
    );
    const id = u!.id;
    await seedStaffFactor(id);
    await ownerQuery(
      `INSERT INTO auth.account (account_id, provider_id, user_id, password, updated_at)
       VALUES ($1::text, 'credential', $1::uuid, 'hash-before', now()), ($1::text, 'google', $1::uuid, NULL, now())`,
      [id],
    );
    await ownerQuery(
      `INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`,
      [id, randomUUID()],
    );
    for (let i = 0; i < 2; i++)
      await ownerQuery(
        `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`,
        [randomUUID(), id],
      );
    return id;
  };
  const left = async (id: string) => ({
    password: (
      await ownerQuery<{ password: string | null }>(
        `SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`,
        [id],
      )
    )[0]?.password,
    factor: (
      await ownerQuery(`SELECT 1 FROM auth.two_factor WHERE user_id = $1`, [id])
    ).length,
    sessions: (
      await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [id])
    ).length,
    idp: (
      await ownerQuery(
        `SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id <> 'credential'`,
        [id],
      )
    ).length,
    apiKeys: (
      await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [
        id,
      ])
    ).length,
  });
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

  it('(iv) a password write that slipped past the pre-write guard (subject is now staff without a factor) is neutralized: password NULL, factor/sessions/IdP/API keys gone; ERROR staff_password_write_neutralized', async () => {
    const id = await staffWithFactorAndCredentials();
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [id]);
    await ownerQuery(
      `UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`,
      [id],
    );
    const errors = vi.spyOn(Logger.prototype, 'error');
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([id]);
        await state.setWriteFactors(new Map([[id, 'factor-before']]));
        await fence.accountUpdated({ path: '/reset-password' });
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      body: { code: 'INVALID_TOKEN' },
    });
    expect(await left(id)).toEqual({
      password: null,
      factor: 0,
      sessions: 0,
      idp: 0,
      apiKeys: 0,
    });
    expect(
      errors.mock.calls.some(([o]) =>
        isEvent(o, 'staff_password_write_neutralized'),
      ),
    ).toBe(true);
    errors.mockRestore();
  });
  it('(iv) a factor that changed between the pre-write check and the write (enrolled with the new password) is neutralized too', async () => {
    const id = await staffWithFactorAndCredentials();
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([id]);
        await state.setWriteFactors(new Map([[id, null]]));
        await fence.accountUpdated({ path: '/change-password' });
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await left(id)).factor).toBe(0);
  });
  it('(iv) staff whose factor id is unchanged (the SP2 reset-by-mail case) → nothing happens', async () => {
    const id = await staffWithFactorAndCredentials();
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth.two_factor WHERE user_id = $1`,
      [id],
    );
    await runWithRequestState(new WeakMap(), async () => {
      await state.setPasswordWriteSubjects([id]);
      await state.setWriteFactors(new Map([[id, row!.id]]));
      await fence.accountUpdated({ path: '/reset-password' });
    });
    expect(await left(id)).toMatchObject({
      factor: 1,
      password: 'hash-before',
    });
  });
  it('a regular user costs one auth connection on session create: BEGIN, the locked factor-state read, COMMIT — nothing else', async () => {
    const counted = createAuthPool(authDatabaseConfig(), databaseConfig());
    const statements: string[] = [];
    let connects = 0;
    const connect = counted.connect.bind(counted);
    vi.spyOn(counted, 'connect').mockImplementation(async () => {
      connects++;
      const client = await connect();
      const query = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(
        (text: unknown, values?: unknown) => {
          statements.push(
            String(text).trim().split(/\s+/).slice(0, 3).join(' '),
          );
          return query(text as string, values as unknown[]);
        },
      );
      return client;
    });
    const direct = vi.spyOn(counted, 'query');
    try {
      const f = createStaffCredentialFence({
        pool: counted,
        stepUp: new StaffStepUp(counted),
        state,
        logger: new Logger('fence-test'),
      });
      const [u] = await ownerQuery<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at) VALUES ('U', $1, true, now(), now(), now()) RETURNING id`,
        [`u-${randomUUID()}@example.test`],
      );
      const [s] = await ownerQuery<{ id: string }>(
        `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
        [randomUUID(), u!.id],
      );
      await f.sessionCreated(
        { id: s!.id, userId: u!.id },
        { path: '/sign-in/email' },
      );
      expect(connects).toBe(1);
      expect(statements).toEqual(['BEGIN', 'SELECT u.role, CASE', 'COMMIT']);
      expect(direct).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await counted.end();
    }
  });
});
