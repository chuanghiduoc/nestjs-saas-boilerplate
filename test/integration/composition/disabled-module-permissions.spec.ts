import { Logger } from '@nestjs/common';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { composeFrom } from '../../../src/boilerplate.modules.js';
import { buildTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

// Trước mọi app: `TenancyMetrics` lấy meter từ provider toàn cục lúc được dựng (một lần mỗi file, Vitest cô lập theo file).
const otel = installOtelCapture();
const ORPHAN_KEY = 'permmod.read';
const ORPHAN_METRIC = 'tenancy_catalogue_orphan_keys';
/** Dòng mà migration của `permmod` đã seed (cờ khớp `PermmodCatalogue`, không `requires`). */
const INSERT_ORPHAN = `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('permmod', 'read', false, false, false)`;

/** `app_user` chỉ đọc `permissions`: ghi bằng role owner, đi thẳng Postgres (mẫu `constraints.spec.ts` của 3A). */
async function asOwner(sql: string, params: unknown[] = []): Promise<void> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await c.connect();
  try {
    await c.query(sql, params);
  } finally {
    await c.end();
  }
}
const deleteOrphan = () =>
  asOwner('DELETE FROM permissions WHERE key = $1', [ORPHAN_KEY]);

/** Composition fixture chỉ có `permmod`; `disable` quyết định nó có được import không. */
const composePermmod = (disable: 'permmod'[]) =>
  composeFrom<'permmod'>(
    {
      modules: {
        permmod: {
          load: async () => {
            const m =
              await import('../../fixtures/composition/permmod/index.js');
            return { api: m.PermmodModule, worker: m.PermmodModule };
          },
        },
      },
      requires: { permmod: [] },
      bridges: [],
      registerRules: () => undefined,
    },
    { disable, features: { api: [], worker: [] } },
  );

/**
 * Lời gọi WARN có nhắc key. Không phụ thuộc hình dạng log của 3A (đối tượng `{ event, keys }`, mảng hay chuỗi): 7A chỉ
 * khẳng định có WARN nêu key, như R-X21 yêu cầu.
 */
const naming = (calls: unknown[][]) =>
  calls.filter((args) => JSON.stringify(args).includes(ORPHAN_KEY));
const orphanMetric = async () => (await otel.metric(ORPHAN_METRIC)) ?? 0;

describe('disabling a module whose permission rows stay in the database (R-X21, 3A Task 20b; spec SP7 §6.2)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    // Như migration của module đã chạy trước khi dự án tắt nó ("Tắt module": migration của module tắt vẫn chạy).
    await deleteOrphan();
    await asOwner(INSERT_ORPHAN);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });
  afterAll(deleteOrphan);

  /** Dựng app tenancy + composition fixture; app PHẢI boot. Trả các lời gọi WARN trong lúc boot. */
  const boot = async (disable: 'permmod'[]): Promise<unknown[][]> => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const composed = await composePermmod(disable);
    const app = await buildTestApp([
      ...tenancyCoreImports(),
      ...composed.worker,
    ]);
    cleanups.push(() => app.close());
    await expect(app.init()).resolves.toBe(app);
    return warn.mock.calls;
  };

  // Thứ tự có nghĩa: bật trước sẽ đánh dấu `permmod` đã import (trạng thái toàn process), và lần tắt sau bị bước 4 của
  // composition từ chối ("disabled but was imported"). Vì vậy ca tắt chạy trước, ca đối chứng (bật) sau.
  it('module disabled: the app boots, logs a WARN naming the orphan key and increments tenancy_catalogue_orphan_keys', async () => {
    const before = await orphanMetric();
    const warns = await boot(['permmod']);
    expect(naming(warns)).not.toEqual([]);
    expect(await orphanMetric()).toBeGreaterThan(before);
  });

  it('control: the same row with the module enabled is not an orphan (no WARN naming it)', async () => {
    expect(naming(await boot([]))).toEqual([]);
  });
});
