import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigOf } from '../../../src/core/config/index.js';
import { identityConfig } from '../../../src/modules/identity/index.js';
import { TenancyUserIds } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

/** Env tối thiểu để config `external` hợp lệ; không module nào ở đây gọi JWKS. */
const EXTERNAL_ENV = {
  AUTH_MODE: 'external',
  AUTH_EXTERNAL_JWKS_URL: 'https://idp.example.test/.well-known/jwks.json',
  AUTH_EXTERNAL_ISSUER: 'https://idp.example.test/',
  AUTH_EXTERNAL_AUDIENCE: 'api',
  AUTH_EXTERNAL_ALGORITHMS: 'RS256',
  AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
  AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
};
const ODD_EXTERNAL_LENGTH = 300;

describe.each(['local', 'external'] as const)(
  'TenancyUserIds in %s mode (spec SP6 §5.3, A-4)',
  (mode) => {
    let app: INestApplication;
    let known: string;
    let knownPublicId: string;
    let unknown: string;
    const principals: SeededPrincipal[] = [];
    beforeAll(async () => {
      if (mode === 'external')
        for (const [k, v] of Object.entries(EXTERNAL_ENV)) vi.stubEnv(k, v);
      else vi.stubEnv('AUTH_MODE', 'local');
      app = await createTestApp(tenancyCoreImports());
      if (mode === 'local') {
        const p = await seedUserPrincipal();
        principals.push(p);
        known = p.authUserId;
        unknown = v7();
      } else {
        known = `ext-${v7()}`;
        unknown = `ext-${v7()}`;
      }
      const column = mode === 'local' ? 'auth_user_id' : 'external_subject';
      const [row] = await ownerQuery<{ public_id: string }>(
        `INSERT INTO tenancy_users (${column}) VALUES ($1) RETURNING public_id::text`,
        [known],
      );
      if (!row) throw new Error('tenancy_users insert returned no row');
      knownPublicId = row.public_id;
    });
    afterAll(async () => {
      // local: `deleteSeededPrincipals` xoá cả dòng tenancy_users của user seed.
      if (mode === 'external')
        await ownerQuery(
          `DELETE FROM tenancy_users WHERE external_subject = $1`,
          [known],
        );
      await deleteSeededPrincipals(principals);
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('maps every subject that has a tenancy_users row to its public id, and leaves the others out', async () => {
      const m = await app
        .get(TenancyUserIds)
        .publicIdsBySubjects([known, unknown]);
      expect(m.get(known)).toBe(knownPublicId);
      expect(m.has(unknown)).toBe(false);
      expect(m.size).toBe(1);
    });
    it('an empty list returns an empty map without a query', async () => {
      expect((await app.get(TenancyUserIds).publicIdsBySubjects([])).size).toBe(
        0,
      );
    });
    it('more than AUTH_DIRECTORY_BATCH_MAX subjects is a caller error', async () => {
      const max = app.get<ConfigOf<typeof identityConfig>>(
        identityConfig.KEY,
      ).directoryBatchMax;
      await expect(
        app
          .get(TenancyUserIds)
          .publicIdsBySubjects(Array.from({ length: max + 1 }, () => v7())),
      ).rejects.toThrow(/at most/);
    });
    it('Review Focus 5: odd subjects map to NULL without a cast error', async () => {
      const odd =
        mode === 'local'
          ? ['not-a-uuid', 'api_key:abc', known.toUpperCase()]
          : ['x'.repeat(ODD_EXTERNAL_LENGTH), ''];
      const m = await app.get(TenancyUserIds).publicIdsBySubjects(odd);
      // UUID hoa vẫn là cùng user ở local (Postgres so uuid không phân biệt hoa thường); khoá là chuỗi đúng như caller đưa.
      if (mode === 'local') {
        expect([...m.keys()]).toEqual([known.toUpperCase()]);
        expect(m.get(known.toUpperCase())).toBe(knownPublicId);
      } else expect(m.size).toBe(0);
    });
  },
);
