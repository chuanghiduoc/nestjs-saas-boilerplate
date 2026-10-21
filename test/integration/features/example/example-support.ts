import type { INestApplication } from '@nestjs/common';
import { SweepModule } from '../../../../src/core/sweep/index.js';
import { ExampleModule } from '../../../../src/features/example/index.js';
import {
  UNLIMITED,
  definePlanCatalogue,
} from '../../../../src/modules/entitlements/index.js';
import type { ConfigureTestingModule } from '../../../support/app-factory.js';
import { startEntitlementsApp } from '../../../support/entitlements-app.js';
import { seedPlans } from '../../../support/entitlements-seed.js';
import {
  inOrgTx,
  withAppClient,
  type SeededOrg,
} from '../../../support/tenancy-seed.js';

/** Trần quota của gói `limited` (spec SP7 §10.4). */
export const LIMITED_MAX = 3;

/**
 * Catalogue gói fixture của mẫu (spec §10.4, D7-6): `free`/`pro` trùng hai dòng của migration mẫu; `limited` đặt trần
 * `example.project_count`, `no_projects` tắt cờ `example.projects`.
 */
export const exampleTestPlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: { values: { 'tenancy.seats': UNLIMITED } },
    limited: { values: { 'example.project_count': { max: LIMITED_MAX } } },
    no_projects: { values: { 'example.projects': false } },
  },
});

/** Dòng `plans` của hai gói chỉ test có (catalogue check đòi gói của code có ở DB). */
export const seedExamplePlans = (): Promise<() => Promise<void>> =>
  seedPlans([{ key: 'limited' }, { key: 'no_projects' }]);

/** App e2e (api + worker events/notifications trong một process) + `SweepModule` + `ExampleModule.forApi()/forWorker()`. */
export function startExampleApp(
  opts: {
    env?: Record<string, string>;
    configure?: ConfigureTestingModule;
  } = {},
): Promise<INestApplication> {
  return startEntitlementsApp(exampleTestPlans, {
    env: opts.env,
    configure: opts.configure,
    extraImports: [
      SweepModule,
      ExampleModule.forApi(),
      ExampleModule.forWorker(),
    ],
  });
}

export const projectsUrl = (orgId: string): string =>
  `/v1/orgs/${orgId}/projects`;

/**
 * Xoá dòng `example_projects` của org (app_user trong OrgScope: FORCE RLS) rồi `org.dispose()`. `PURGE_ORDER` của
 * `tenancy-seed.ts` là của boilerplate, không biết bảng template: FK RESTRICT làm dispose fail nếu còn dòng (review M8).
 */
export async function disposeExampleOrg(org: SeededOrg): Promise<void> {
  await withAppClient((c) =>
    inOrgTx(c, org.orgId, () =>
      c.query('DELETE FROM example_projects WHERE org_id = app_current_org()'),
    ),
  );
  await org.dispose();
}

export type ProjectDbRow = {
  publicId: string;
  name: string;
  status: string;
  version: number;
};
/** Dòng của org đọc bằng app_user trong OrgScope (FORCE RLS: owner thấy 0 dòng), mới nhất trước. */
export async function projectRowsOf(orgId: string): Promise<ProjectDbRow[]> {
  return withAppClient((c) =>
    inOrgTx(
      c,
      orgId,
      async () =>
        (
          await c.query<ProjectDbRow>(
            `SELECT public_id::text AS "publicId", name, status, version FROM example_projects
           WHERE org_id = app_current_org() ORDER BY public_id DESC`,
          )
        ).rows,
    ),
  );
}
