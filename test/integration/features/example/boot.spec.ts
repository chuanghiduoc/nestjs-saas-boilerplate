import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SweepModule } from '../../../../src/core/sweep/index.js';
import { ExampleModule } from '../../../../src/features/example/index.js';
import { buildTestApp } from '../../../support/app-factory.js';
import { entitlementsCoreImports } from '../../../support/entitlements-app.js';
import { withOwner } from '../../../support/entitlements-seed.js';
import {
  exampleTestPlans,
  seedExamplePlans,
  startExampleApp,
} from './example-support.js';

describe('the sample boots through the SP4 and SP3 catalogue checks (EX-I14)', () => {
  let disposePlans: () => Promise<void>;
  let app: INestApplication | undefined;
  beforeAll(async () => {
    disposePlans = await seedExamplePlans();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await disposePlans?.();
  });

  it('api + worker composition with ExampleModule boots; EntitlementRouteInventory accepts the gated routes', async () => {
    app = await startExampleApp();
    expect(app.get(ExampleModule)).toBeDefined();
  });
  it('without one example entitlement_features row the boot fails naming the key (code key missing in the DB)', async () => {
    // Dòng FLAG chưa có override/bộ đếm nào tham chiếu; `id` mới khi chèn lại không ảnh hưởng app khác (đọc lúc boot).
    await withOwner((c) =>
      c.query(
        `DELETE FROM entitlement_features WHERE key = 'example.projects'`,
      ),
    );
    try {
      app = await buildTestApp(
        entitlementsCoreImports(exampleTestPlans, [
          SweepModule,
          ExampleModule.forWorker(),
        ]),
      );
      await expect(app.init()).rejects.toThrow(
        /example\.projects: in code, missing in the database/,
      );
    } finally {
      await withOwner((c) =>
        c.query(
          `INSERT INTO entitlement_features (key, kind, reset_period) VALUES ('example.projects', 'FLAG', NULL)
           ON CONFLICT (key) DO NOTHING`,
        ),
      );
    }
  });
});
