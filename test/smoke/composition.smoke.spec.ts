import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { compose, logsSince, psql, workerHealth } from './smoke-support.js';

/** Chạy trong container worker (ENTRYPOINT distroless là node): import composition của `dist/` bằng top-level await. */
const LOADED_MODULES_SCRIPT = [
  "const { loadedModules } = await import('./dist/core/config/index.js');",
  "await import('./dist/app.modules.js');",
  'process.stdout.write(JSON.stringify([...loadedModules()]));',
].join(' ');
const COMPOSE_RUN_TIMEOUT_MS = 60_000;
/** Worker khởi động lại trên image production tới healthy: rộng hơn nhiều so với thực tế. */
const WORKER_HEALTHY_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 1_000;
/** Mức pino của WARN. */
const PINO_WARN = 40;
/** Key quyền của một module "đã tắt": dòng còn trong DB, không catalogue nào trong image khai (R-X21). */
const ORPHAN_KEY = 'smokeorphan.read';
const PinoLine = z.object({ level: z.number() }).passthrough();
const StaticSync = z.object({
  upserted: z.array(z.string()),
  removed: z.array(z.string()),
});
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    // Dòng không phải JSON (không phải log pino): không phải dòng cần tìm.
    return undefined;
  }
};

describe('prod-like smoke: composition (SP7 7A)', () => {
  const { startedAt } = inject('smoke');

  it('dist/app.modules.js composes with top-level await on the production image and loads exactly the enabled modules', () => {
    const out = compose(
      [
        'run',
        '--rm',
        '--no-deps',
        'worker',
        '--input-type=module',
        '-e',
        LOADED_MODULES_SCRIPT,
      ],
      { timeoutMs: COMPOSE_RUN_TIMEOUT_MS },
    );
    expect(
      z
        .array(z.string())
        .parse(JSON.parse(out.trim().split('\n').at(-1) ?? '')),
    ).toEqual(['notifications', 'identity', 'tenancy', 'entitlements']);
  });

  it('the worker synced the static crons of every enabled module and removed none', () => {
    const syncs = logsSince(startedAt)
      .split('\n')
      .flatMap((line) => {
        const r = StaticSync.safeParse(jsonOf(line));
        return r.success ? [r.data] : [];
      });
    expect(syncs.length).toBeGreaterThan(0);
    for (const s of syncs) {
      expect(s.upserted).toEqual(
        expect.arrayContaining([
          'static-core.outbox.cleanup',
          'static-notifications.purge-deliveries',
          'static-identity.purge-expired',
          'static-tenancy.orgs.purge',
        ]),
      );
      expect(s.removed).toEqual([]);
    }
  });

  // M6 (R-X21 trên image thật, ca cuối của file): dòng quyền của một module bị tắt ở lại trong DB; worker khởi động lại
  // phải healthy và log WARN nêu key (3A Task 20b), không crash-loop.
  it(
    'an orphan permission row (a disabled module) is a WARN at worker boot on the production image; the worker stays healthy',
    async () => {
      psql(`DELETE FROM permissions WHERE key = '${ORPHAN_KEY}'`);
      psql(
        `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('smokeorphan', 'read', false, false, false)`,
      );
      try {
        const restartedAt = new Date().toISOString();
        compose(['restart', 'worker'], { timeoutMs: COMPOSE_RUN_TIMEOUT_MS });
        const deadline = Date.now() + WORKER_HEALTHY_TIMEOUT_MS;
        let health = workerHealth();
        while (health !== 'healthy' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
          health = workerHealth();
        }
        expect(health).toBe('healthy');
        const warns = logsSince(restartedAt)
          .split('\n')
          .filter((line) => {
            const r = PinoLine.safeParse(jsonOf(line));
            return (
              r.success &&
              r.data.level === PINO_WARN &&
              line.includes(ORPHAN_KEY)
            );
          });
        expect(warns.length).toBeGreaterThan(0);
      } finally {
        // Dọn ở mọi nhánh: dòng orphan chỉ ảnh hưởng lần boot kế, không cần khởi động lại worker lần nữa.
        psql(`DELETE FROM permissions WHERE key = '${ORPHAN_KEY}'`);
      }
    },
    WORKER_HEALTHY_TIMEOUT_MS + COMPOSE_RUN_TIMEOUT_MS,
  );
});
