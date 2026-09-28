import { Logger } from '@nestjs/common';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { UnverifiedLinkRevoker } from '../../../src/modules/identity/infra/better-auth/unverified-links.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';

/** Before any revoker exists: the metrics API has no proxy, a counter binds to the provider set at creation. */
const otel = installOtelCapture();
const PROVIDER = 'corp';
const FENCE_METRIC = 'identity_session_fence_rejected_total';
const RECLAIM_METRIC = 'identity_account_reclaimed_total';

/**
 * Task 39 M5: when the S2-R40 fence finds the session already revoked by a reclaim, it refuses the login with its own
 * metric outcome and an info log, and never counts it as a fence delete (`identity_account_reclaimed_total{late-session}`).
 */
describe('late-session fence: every refusal is counted by outcome', () => {
  let pool: pg.Pool;
  let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    vi.unstubAllEnvs();
  });

  /** An unverified user signed in through an IdP: one provider link, one session. */
  const seed = async () => {
    const {
      rows: [u],
    } = await owner.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified) VALUES ('Idp', $1, false) RETURNING id`,
      [`fence-${v7()}@example.test`],
    );
    const userId = u!.id;
    await owner.query(
      `INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, $2, $3, now())`,
      [`sub-${v7()}`, PROVIDER, userId],
    );
    const {
      rows: [s],
    } = await owner.query<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at)
       VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
      [randomBytes(24).toString('hex'), userId],
    );
    return { userId, sessionId: s!.id };
  };
  const counts = async () => ({
    deleted: await otel.metric(FENCE_METRIC, { outcome: 'deleted' }),
    alreadyRevoked: await otel.metric(FENCE_METRIC, {
      outcome: 'already-revoked',
    }),
    lateSession: await otel.metric(RECLAIM_METRIC, {
      trigger: 'late-session',
    }),
  });

  it('already revoked by the reclaim: refused, counted as already-revoked with an info log, never as a fence delete', async () => {
    const revoker = new UnverifiedLinkRevoker(pool);
    const { userId, sessionId } = await seed();
    // The reclaim already ran: link and session are gone.
    await owner.query(`DELETE FROM auth.account WHERE user_id = $1`, [userId]);
    await owner.query(`DELETE FROM auth.session WHERE user_id = $1`, [userId]);
    const before = await counts();
    const info = vi.spyOn(Logger.prototype, 'log');
    try {
      expect(
        await revoker.fenceLateSession({ id: sessionId, userId }, PROVIDER),
      ).toBe(true);
      expect(info).toHaveBeenCalledWith(
        { event: 'identity_session_fence_already_revoked', userId },
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
    const after = await counts();
    expect((after.alreadyRevoked ?? 0) - (before.alreadyRevoked ?? 0)).toBe(1);
    expect(after.deleted).toBe(before.deleted);
    expect(after.lateSession).toBe(before.lateSession);
  });

  it('link gone but session alive: the fence deletes it, counted as deleted and as a late-session reclaim', async () => {
    const revoker = new UnverifiedLinkRevoker(pool);
    const { userId, sessionId } = await seed();
    await owner.query(`DELETE FROM auth.account WHERE user_id = $1`, [userId]);
    const before = await counts();
    expect(
      await revoker.fenceLateSession({ id: sessionId, userId }, PROVIDER),
    ).toBe(true);
    const after = await counts();
    expect((after.deleted ?? 0) - (before.deleted ?? 0)).toBe(1);
    expect((after.lateSession ?? 0) - (before.lateSession ?? 0)).toBe(1);
    expect(after.alreadyRevoked).toBe(before.alreadyRevoked);
  });

  it('link still there: the session stays and nothing is counted', async () => {
    const revoker = new UnverifiedLinkRevoker(pool);
    const { userId, sessionId } = await seed();
    const before = await counts();
    expect(
      await revoker.fenceLateSession({ id: sessionId, userId }, PROVIDER),
    ).toBe(false);
    expect(await counts()).toEqual(before);
  });
});
