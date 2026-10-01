import type { INestApplication } from '@nestjs/common';
import {
  ToxiProxyContainer,
  type CreatedProxy,
  type StartedToxiProxyContainer,
} from '@testcontainers/toxiproxy';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/core/database/index.js';
import { SqlInvitationRepository } from '../../src/modules/tenancy/infra/sql/sql-invitation.repository.js';
import { SqlInviteLinkRepository } from '../../src/modules/tenancy/infra/sql/sql-invite-link.repository.js';
import type { InvitationRow } from '../../src/modules/tenancy/ports/invitation-repository.js';
import type { InviteLinkRow } from '../../src/modules/tenancy/ports/invite-link-repository.js';
import { getInfra } from '../support/infra.js';
import { readImages } from '../support/images.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import {
  acceptInvitation,
  joinInviteLink,
  previewIp,
  previewToken,
} from '../support/tenancy-acquisition.js';
import { startTenancyApp } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import {
  inOrgTx,
  newToken,
  seedInvitation,
  seedInviteLink,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../support/tenancy-seed.js';

const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };
const REDIS_PORT = 6379;
const PREVIEW_LIMIT = 3;

/** Bật blackhole đúng lúc câu khoá lời mời chạy: khoá org và khoá tenancy_users đã xong qua proxy. */
class BlackholeOnInvitationLock extends SqlInvitationRepository {
  armed: TcpProxy | undefined;
  override lockById(id: string): Promise<InvitationRow | undefined> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.lockById(id);
  }
}
class BlackholeOnLinkLock extends SqlInviteLinkRepository {
  armed: TcpProxy | undefined;
  override lockById(id: string): Promise<InviteLinkRow | undefined> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.lockById(id);
  }
}

describe('app DB lost inside accept and join (spec SP3 tiêu chí 12, phần 3C)', () => {
  let proxy: TcpProxy;
  let app: INestApplication;
  let invitations: BlackholeOnInvitationLock | undefined;
  let links: BlackholeOnLinkLock | undefined;
  let owner: SeededPrincipal;
  let invitee: SeededPrincipal;
  let org: SeededOrg;
  const sql = (q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    app = await startTenancyApp({
      env: {
        DB_HOST: '127.0.0.1',
        DB_PORT: String(proxy.port),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
      configure: (b) =>
        b
          .overrideProvider(SqlInvitationRepository)
          .useFactory({
            factory: (db: Db) =>
              (invitations = new BlackholeOnInvitationLock(db)),
            inject: [Db],
          })
          .overrideProvider(SqlInviteLinkRepository)
          .useFactory({
            factory: (db: Db) => (links = new BlackholeOnLinkLock(db)),
            inject: [Db],
          }),
    });
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([owner, invitee]);
    vi.unstubAllEnvs();
  });

  it('accept: DB lost at the invitation lock → 503 within the bound; the invitation stays PENDING, no member; a retry after recovery is 201', async () => {
    const repo = invitations;
    if (!repo)
      throw new Error('the SqlInvitationRepository override was not built');
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    repo.armed = proxy;
    try {
      const started = performance.now();
      const r = await acceptInvitation(app, invitee, { token: inv.token });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      // Không kỳ vọng Retry-After: chỉ đường tra membership (lookup có guard) đặt nó (spec §18.4); DB mất trong handler
      // đi qua `dbErrorMapper` của core → `503 service_unavailable` không header (tiêu chí 12 chỉ đòi 503, không 500).
      expect(repo.armed).toBeUndefined();
    } finally {
      repo.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(
      async () =>
        expect(
          (
            await sql('SELECT status FROM org_invitations WHERE id = $1', [
              inv.id,
            ])
          ).rows,
        ).toEqual([{ status: 'PENDING' }]),
      RECOVERY,
    );
    await vi.waitFor(
      async () =>
        expect(
          (await acceptInvitation(app, invitee, { token: inv.token })).status,
        ).toBe(201),
      RECOVERY,
    );
  });
  it('join: DB lost at the link lock → 503; use_count unchanged; a retry after recovery is 201', async () => {
    const repo = links;
    if (!repo)
      throw new Error('the SqlInviteLinkRepository override was not built');
    const joiner = await seedUserPrincipal();
    try {
      const link = await seedInviteLink(org, {
        roleId: org.roles.MEMBER.id,
        createdByMemberId: org.owner.memberId,
      });
      repo.armed = proxy;
      try {
        const r = await joinInviteLink(app, joiner, { token: link.token });
        expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      } finally {
        repo.armed = undefined;
        proxy.state.blackhole = false;
      }
      await vi.waitFor(
        async () =>
          expect(
            (await joinInviteLink(app, joiner, { token: link.token })).status,
          ).toBe(201),
        RECOVERY,
      );
      expect(
        (
          await sql('SELECT use_count FROM org_invite_links WHERE id = $1', [
            link.id,
          ])
        ).rows,
      ).toEqual([{ use_count: 1 }]);
    } finally {
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(
            'DELETE FROM org_members WHERE user_id = (SELECT id FROM tenancy_users WHERE auth_user_id = $1)',
            [joiner.authUserId],
          ),
        ),
      );
      await deleteSeededPrincipals([joiner]);
    }
  });
});

describe('Redis down: token previews fall back to the per-pod insurance limiter, accept (idempotent) answers 503 (spec §18.4, CDX-13)', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;
  let owner: SeededPrincipal;
  let invitee: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const images = readImages();
    if (!images.IMAGE_REDIS || !images.IMAGE_TOXIPROXY)
      throw new Error(
        'IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env',
      );
    network = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS)
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(REDIS_PORT)
      .start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY)
      .withNetwork(network)
      .start();
    proxy = await toxi.createProxy({
      name: 'redis',
      upstream: `redis:${REDIS_PORT}`,
    });
    app = await startTenancyApp({
      env: {
        REDIS_URL: `redis://${proxy.host}:${proxy.port}`,
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_TOKEN_PREVIEW_RATE_LIMIT: String(PREVIEW_LIMIT),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await proxy?.setEnabled(true);
    await org?.dispose();
    await app?.close();
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    await deleteSeededPrincipals([owner, invitee]);
    vi.unstubAllEnvs();
  });

  it('previews: PREVIEW_LIMIT × 404 then 429 from one IP while Redis is down; accept → 503 and the invitation stays PENDING', async () => {
    if (!app || !proxy) throw new Error('not started');
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    await proxy.setEnabled(false);
    try {
      const ip = previewIp();
      for (let i = 0; i < PREVIEW_LIMIT; i++)
        expect(
          (await previewToken(app, 'invitations', { token: newToken() }, ip))
            .status,
          `preview ${i + 1}`,
        ).toBe(404);
      expect(
        (await previewToken(app, 'invitations', { token: newToken() }, ip))
          .status,
      ).toBe(429);
      expect(
        (await acceptInvitation(app, invitee, { token: inv.token })).status,
      ).toBe(503);
    } finally {
      await proxy.setEnabled(true);
    }
    expect(
      (
        await withAppClient((c) =>
          inOrgTx(c, org.orgId, () =>
            c.query('SELECT status FROM org_invitations WHERE id = $1', [
              inv.id,
            ]),
          ),
        )
      ).rows,
    ).toEqual([{ status: 'PENDING' }]);
  });
});
