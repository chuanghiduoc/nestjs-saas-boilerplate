import { MODULE_METADATA } from '@nestjs/common/constants.js';
import type { DynamicModule, Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { tenancyControllerModules } from '../../../../src/modules/tenancy/http/tenancy-http.module.js';
import { TenancyModule } from '../../../../src/modules/tenancy/index.js';

type Imp = Type | DynamicModule | Promise<DynamicModule>;
const isDynamic = (m: Imp): m is DynamicModule =>
  typeof m === 'object' && 'module' in m;

/** Duyệt cây import của `TenancyModule.forApi()`; gom module (tenancy) có controller. */
function modulesWithControllers(root: DynamicModule): Type[] {
  const found = new Set<Type>();
  const seen = new Set<unknown>();
  const visit = (m: Imp): void => {
    if (m instanceof Promise || seen.has(m)) return;
    seen.add(m);
    const type = isDynamic(m) ? m.module : m;
    const controllers: unknown[] = [
      ...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, type) ?? []),
      ...(isDynamic(m) ? (m.controllers ?? []) : []),
    ];
    if (controllers.length > 0) found.add(type);
    const imports: Imp[] = [
      ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, type) ?? []),
      ...(isDynamic(m) ? (m.imports ?? []) : []),
    ];
    for (const i of imports) visit(i);
  };
  visit(root);
  return [...found];
}

describe('TENANCY_CONTROLLER_MODULES (spec SP3 §7.1, G-8)', () => {
  it('lists exactly the tenancy modules that declare controllers', () => {
    expect(new Set(tenancyControllerModules())).toEqual(
      new Set(modulesWithControllers(TenancyModule.forApi())),
    );
  });
});
