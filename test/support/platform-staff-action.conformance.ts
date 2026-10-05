import { Global, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformAccessAudit,
  type PlatformAccessEntry,
} from '../../src/modules/identity/index.js';
import type { ModuleImport } from './app-factory.js';
import { TEST_ORIGIN } from './auth-client.js';
import {
  FAKE_IDP_CLIENT_ID,
  FAKE_IDP_CLIENT_SECRET,
  startFakeIdp,
  type FakeIdp,
} from './fake-idp.js';
import { startFakeJwks, type FakeJwks } from './fake-jwks.js';
import { seedStaffFactor, seedStepUpMark } from './seed-staff-step-up.js';
import { startTenancyApp } from './tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from './tenancy-principals.js';
import { seedOrg, seedOrgApiKey, type SeededOrg } from './tenancy-seed.js';

export type PlatformStaffConformanceTarget = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectAllowedStatus: number;
};
type Mode = 'local' | 'hybrid' | 'external';
export type ConformanceContext = {
  readonly app: INestApplication;
  readonly mode: Mode;
};
/**
 * Lệch có chủ đích khỏi chữ ký hai tham số của addendum A5: helper không biết module nào chứa route, nên module gọi truyền
 * `extraImports` (thêm, tuỳ chọn; gọi hai tham số vẫn hợp lệ). `handlerCalls`: bộ đếm lần chạy handler của route (C9, C10);
 * vắng thì C10 chỉ kiểm được `503` và port không ghi, không kiểm được "handler không chạy".
 */
export type ConformanceOptions = {
  readonly extraImports?: ModuleImport[];
  readonly modes?: readonly Mode[];
  readonly handlerCalls?: () => number;
};

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const ADMIN_CLAIM = 'role';
const TOKEN_TTL_SEC = 300;
/** Cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` mặc định (600 s) (C7, C8). */
const STALE_SEC = 3_600;
/** PSA-7: bảng của dấu step-up; chỉ câu dấu của `staff-step-up.ts` (và FK/CASCADE phía DB) chạm nó. */
const SESSION_MARK_TABLE = 'auth.session_second_factor';
const nowSec = () => Math.floor(Date.now() / 1000);

/** Port fixture ghi lại entry (C9) hoặc ném (C10); thứ tự với handler kiểm bằng `handlerCalls` lúc `record` chạy. */
class ConformanceAudit extends PlatformAccessAudit {
  entries: { entry: PlatformAccessEntry; handlerCallsAtRecord: number }[] = [];
  fail = false;
  handlerCalls: () => number = () => 0;
  record(entry: PlatformAccessEntry): Promise<void> {
    if (this.fail)
      return Promise.reject(new Error('conformance: audit store down'));
    this.entries.push({ entry, handlerCallsAtRecord: this.handlerCalls() });
    return Promise.resolve();
  }
}
const audit = new ConformanceAudit();
@Global()
@Module({
  providers: [{ provide: PlatformAccessAudit, useValue: audit }],
  exports: [PlatformAccessAudit],
})
class ConformanceAuditModule {}

/** Template `v1/a/:x` khớp path `/v1/a/42?q=1` → `{ x: '42' }`; không khớp → `undefined`. */
function paramsFromPath(
  template: string,
  path: string,
): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':'))
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  const m = new RegExp(`^/?${pattern}$`).exec(path.split('?')[0] ?? '');
  if (!m) return undefined;
  return Object.fromEntries(
    names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]),
  );
}
/** Mọi giá trị chuỗi của query và body (A-D5: không giá trị nào được vào entry). */
function queryAndBodyValues(t: PlatformStaffConformanceTarget): string[] {
  const query = [...new URLSearchParams(t.path.split('?')[1] ?? '').values()];
  const leaves = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : typeof v === 'number' || typeof v === 'boolean'
        ? []
        : Array.isArray(v)
          ? v.flatMap(leaves)
          : v !== null && typeof v === 'object'
            ? Object.values(v).flatMap(leaves)
            : [];
  return [...query, ...leaves(t.body)].filter((s) => s !== '');
}

/**
 * Addendum A5: C1–C10 cho MỘT route `@PlatformStaffAction()` ở mỗi `AUTH_MODE`. Module gọi hàm này cho mọi route admin của
 * mình; không định nghĩa lại mã lỗi, không test lại gate. C11 (lỗi hạ tầng của câu dấu) chỉ ở chaos của 3D.
 */
export function describePlatformStaffActionConformance(
  name: string,
  target: (ctx: ConformanceContext) => PlatformStaffConformanceTarget,
  opts: ConformanceOptions = {},
): void {
  const handlerCalls = opts.handlerCalls ?? (() => 0);
  for (const mode of opts.modes ?? (['local', 'hybrid', 'external'] as const))
    describe(`${name} — @PlatformStaffAction conformance [${mode}] (addendum A5)`, () => {
      let app: INestApplication;
      let jwks: FakeJwks | undefined;
      let idp: FakeIdp | undefined;
      let org: SeededOrg | undefined;
      const principals: SeededPrincipal[] = [];
      const local = mode !== 'external';
      const tgt = () => target({ app, mode });
      const send = (
        t: PlatformStaffConformanceTarget,
        auth: Record<string, string>,
      ) => {
        const agent = request(app.getHttpServer());
        const method = t.method.toLowerCase() as Lowercase<
          PlatformStaffConformanceTarget['method']
        >;
        let req = agent[method](t.path).set('origin', TEST_ORIGIN);
        for (const [k, v] of Object.entries({ ...t.headers, ...auth }))
          req = req.set(k, v);
        return t.body === undefined ? req : req.send(t.body as object);
      };
      const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
      const signed = (sub: string, extra: Record<string, unknown>) => {
        if (!jwks)
          throw new Error('conformance: no fake JWKS outside external');
        return jwks.sign({
          iss: ISS,
          aud: AUD,
          sub,
          iat: nowSec(),
          exp: nowSec() + TOKEN_TTL_SEC,
          idtyp: 'user',
          ...extra,
        });
      };
      const staffToken = (sub: string, extra: Record<string, unknown>) =>
        signed(sub, { [ADMIN_CLAIM]: 'admin', ...extra });
      const user = async (
        o: Parameters<typeof seedUserPrincipal>[0] = {},
      ): Promise<SeededPrincipal> => {
        const p = await seedUserPrincipal(o);
        principals.push(p);
        return p;
      };
      const staff = async (
        o: Parameters<typeof seedStaffPrincipal>[0] = {},
      ): Promise<SeededPrincipal> => {
        const p = await seedStaffPrincipal(o);
        principals.push(p);
        return p;
      };
      /** Một principal nhân viên hợp lệ của mode và id mà entry phải mang (C9). */
      const validStaff = async (): Promise<{
        auth: Record<string, string>;
        actorId: string;
      }> => {
        if (local) {
          const p = await staff();
          return { auth: bearer(p.bearer), actorId: p.authUserId };
        }
        const sub = `staff-${v7()}`;
        return {
          auth: bearer(await staffToken(sub, { auth_time: nowSec() })),
          actorId: sub,
        };
      };

      beforeAll(async () => {
        const env: Record<string, string> = {};
        if (mode === 'external') {
          jwks = await startFakeJwks();
          Object.assign(env, {
            AUTH_MODE: 'external',
            BETTER_AUTH_SECRET: '',
            DB_AUTH_PASSWORD: '',
            AUTH_EXTERNAL_JWKS_URL: jwks.url,
            AUTH_EXTERNAL_ISSUER: ISS,
            AUTH_EXTERNAL_AUDIENCE: AUD,
            AUTH_EXTERNAL_ALGORITHMS: 'RS256',
            AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
            AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
            AUTH_EXTERNAL_ADMIN_CLAIM: ADMIN_CLAIM,
            AUTH_EXTERNAL_ADMIN_VALUE: 'admin',
            RESILIENCE_ALLOWED_SCHEMES: 'http,https',
            RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
            RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
          });
        }
        if (mode === 'hybrid') {
          idp = await startFakeIdp({
            redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp`,
          });
          Object.assign(env, {
            AUTH_MODE: 'hybrid',
            AUTH_OIDC_PROVIDER_ID: 'corp',
            AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
            AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
            AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
            AUTH_TRUSTED_PROVIDERS: 'corp',
          });
        }
        app = await startTenancyApp({
          env,
          extraImports: [ConformanceAuditModule, ...(opts.extraImports ?? [])],
        });
        audit.handlerCalls = handlerCalls;
        org = local
          ? await seedOrg({ owner: { authUserId: (await user()).authUserId } })
          : await seedOrg({ owner: { externalSubject: `owner-${v7()}` } });
      });
      afterAll(async () => {
        await org?.dispose();
        await app?.close();
        await jwks?.close();
        await idp?.close();
        await deleteSeededPrincipals(principals);
        vi.unstubAllEnvs();
      });
      const refused = async (
        auth: Record<string, string>,
        status: number,
        code: string,
      ) => {
        const before = audit.entries.length;
        const calls = handlerCalls();
        const r = await send(tgt(), auth);
        expect([r.status, r.body.code]).toEqual([status, code]);
        expect(
          audit.entries.length,
          'a refused request never reaches PlatformAccessAudit (A-D6)',
        ).toBe(before);
        expect(handlerCalls(), 'a refused request never runs the handler').toBe(
          calls,
        );
      };

      it('C1: no credential → 401', () => refused({}, 401, 'unauthenticated'));
      it('C2: a session that is not staff → 403 forbidden', async () => {
        if (local)
          await refused(bearer((await user()).bearer), 403, 'forbidden');
        else
          await refused(
            bearer(await signed(`user-${v7()}`, { auth_time: nowSec() })),
            403,
            'forbidden',
          );
      });
      it('C3: a Better Auth API key → 403 forbidden (local/hybrid), 401 (external)', async () => {
        if (!local)
          return refused(
            { 'x-api-key': 'not-an-org-key' },
            401,
            'unauthenticated',
          );
        const u = await user();
        const created = await request(app.getHttpServer())
          .post('/api/auth/api-key/create')
          .set('authorization', `Bearer ${u.bearer}`)
          .set('origin', TEST_ORIGIN)
          .send({ name: 'conformance' });
        expect(created.status).toBe(200);
        await refused(
          { 'x-api-key': String(created.body.key) },
          403,
          'forbidden',
        );
      });
      it('C4: an org API key → 403 api_key_not_allowed_here', async () => {
        if (!org) throw new Error('conformance: org not seeded');
        const key = await seedOrgApiKey(org, {
          createdByMemberId: org.owner.memberId,
          permissions: ['org.read'],
        });
        await refused(
          { 'x-api-key': key.token },
          403,
          'api_key_not_allowed_here',
        );
      });
      it.skipIf(!local)(
        'C5–C7 (local/hybrid): staff without a step-up, with a backup-code step-up, or with a stale TOTP mark → 403 second_factor_required',
        async () => {
          for (const o of [
            { mark: false },
            { method: 'backup_code' as const },
            { markAgeSec: STALE_SEC },
          ])
            await refused(
              bearer((await staff(o)).bearer),
              403,
              'second_factor_required',
            );
        },
      );
      it.skipIf(local)(
        'C8 (external): staff token without auth_time, or with a stale one → 403 reauthentication_required',
        async () => {
          await refused(
            bearer(await staffToken(`staff-${v7()}`, {})),
            403,
            'reauthentication_required',
          );
          await refused(
            bearer(
              await staffToken(`staff-${v7()}`, {
                auth_time: nowSec() - STALE_SEC,
              }),
            ),
            403,
            'reauthentication_required',
          );
        },
      );
      it('C9: valid staff → expectAllowedStatus; exactly one entry (template, path params, actor, credential kind), recorded before the handler', async () => {
        const { auth, actorId } = await validStaff();
        const t = tgt();
        const before = audit.entries.length;
        const calls = handlerCalls();
        const r = await send(t, auth);
        expect(r.status).toBe(t.expectAllowedStatus);
        const added = audit.entries.slice(before);
        expect(added).toHaveLength(1);
        const [{ entry, handlerCallsAtRecord }] = added as [
          (typeof added)[number],
        ];
        expect(entry.method).toBe(t.method);
        expect(
          entry.params,
          `routeTemplate "${entry.routeTemplate}" does not match ${t.path}`,
        ).toEqual(paramsFromPath(entry.routeTemplate, t.path));
        expect(entry.actor).toEqual({ type: 'user', id: actorId });
        expect(entry.credentialKind).toBe(
          local ? 'BEARER_SESSION' : 'EXTERNAL_BEARER',
        );
        expect(handlerCallsAtRecord, 'recorded before the handler ran').toBe(
          calls,
        );
        if (opts.handlerCalls) expect(handlerCalls()).toBe(calls + 1);
        const serialized = JSON.stringify(entry);
        for (const v of queryAndBodyValues(t))
          expect(
            serialized,
            'no query or body value in the entry (A-D5)',
          ).not.toContain(v);
      });
      it('C10: the audit port throws → 503 + Retry-After, the handler does not run', async () => {
        const { auth } = await validStaff();
        const before = audit.entries.length;
        const calls = handlerCalls();
        audit.fail = true;
        try {
          const r = await send(tgt(), auth);
          expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
          expect(r.headers['retry-after']).toBeDefined();
        } finally {
          audit.fail = false;
        }
        expect(handlerCalls()).toBe(calls);
        expect(audit.entries.length).toBe(before);
      });
      it.skipIf(!local)(
        'PSA-7 (local/hybrid): a non-staff session never runs the step-up mark query in the guard',
        async () => {
          // Người thường có factor và dấu TOTP tươi: nếu guard chạy câu dấu cho họ, câu đó tìm thấy dòng (và có thể cho qua).
          const u = await user();
          await seedStepUpMark({
            sessionId: u.sessionId,
            factorId: await seedStaffFactor(u.authUserId),
          });
          const s = await staff();
          // Đếm câu thật mọi client `pg` gửi (pool `auth_user` lẫn mọi pool khác), không qua bộ đếm thống kê của Postgres:
          // số lần quét bảng phụ thuộc plan và lúc backend đẩy thống kê, số câu thì không.
          const sent = vi.spyOn(pg.Client.prototype, 'query');
          const markQueries = () =>
            sent.mock.calls.filter(([q]) =>
              (typeof q === 'string' ? q : (q as { text?: unknown }).text)
                ?.toString()
                .includes(SESSION_MARK_TABLE),
            ).length;
          try {
            // Đối chứng dương: request "dò" của nhân viên dừng ở port audit (503, handler của route thật không chạy) và
            // phải hiện ra ở bộ đếm, không thì số 0 bên dưới không chứng minh gì.
            audit.fail = true;
            try {
              expect((await send(tgt(), bearer(s.bearer))).status).toBe(503);
            } finally {
              audit.fail = false;
            }
            expect(markQueries()).toBeGreaterThan(0);
            sent.mockClear();
            const r = await send(tgt(), bearer(u.bearer));
            expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
            expect(markQueries()).toBe(0);
          } finally {
            sent.mockRestore();
          }
        },
      );
    });
}
