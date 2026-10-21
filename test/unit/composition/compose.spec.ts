import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOILERPLATE_MODULES,
  MODULE_REQUIRES,
  OPTIONAL_BRIDGES,
  composeAppModules,
  composeFrom,
  type BoilerplateModuleKey,
  type Composition,
  type ModulePair,
} from '../../../src/boilerplate.modules.js';
import {
  loadedModules,
  markModuleLoaded,
} from '../../../src/core/config/index.js';
import {
  disabledModuleKeys,
  setDisabledModuleKeys,
} from '../../../src/core/scheduler/index.js';

class Feature {}
const pairOf = (): ModulePair => {
  class Api {}
  class Worker {}
  return { api: Api, worker: Worker };
};

let seq = 0;
/**
 * Composition fixture `a` ← `b` (b cần a) cộng một cầu nối `when: [a, b]`. Mỗi ca một bộ khoá riêng: `markModuleLoaded`
 * là trạng thái toàn process, không reset được giữa các ca.
 */
function fixture(o: { marks?: boolean; bridgeWhen?: string[] } = {}) {
  seq += 1;
  const a = `fa${seq}`;
  const b = `fb${seq}`;
  const pairs = { a: pairOf(), b: pairOf(), bridge: pairOf() };
  const loader = (key: string, pair: ModulePair) =>
    vi.fn(() => {
      if (o.marks !== false) markModuleLoaded(key);
      return Promise.resolve(pair);
    });
  const loads = { a: loader(a, pairs.a), b: loader(b, pairs.b) };
  const bridgeLoad = vi.fn(() => Promise.resolve(pairs.bridge));
  const registerRules = vi.fn();
  const c: Composition<string> = {
    modules: { [a]: { load: loads.a }, [b]: { load: loads.b } },
    requires: { [a]: [], [b]: [a] },
    bridges: [
      { key: `br${seq}`, when: o.bridgeWhen ?? [a, b], load: bridgeLoad },
    ],
    registerRules,
  };
  return { a, b, c, pairs, loads, bridgeLoad, registerRules };
}
const noFeatures = { api: [], worker: [] };

describe('composeFrom (spec SP7 §6.2)', () => {
  afterEach(() => setDisabledModuleKeys([]));

  it('entitlements enabled without a plan catalogue fails by name before any import, and does not count as the one run (SP4 S4-D22)', async () => {
    await expect(
      composeAppModules({ disable: [], features: noFeatures }),
    ).rejects.toThrow(
      'composeAppModules: "plans" is required while entitlements is enabled',
    );
    expect(loadedModules().has('entitlements')).toBe(false);
  });

  it('loads enabled modules in declaration order, then bridges, then features, into both roles', async () => {
    const f = fixture();
    const r = await composeFrom(f.c, {
      features: { api: [Feature], worker: [Feature] },
    });
    expect(r.api).toEqual([
      f.pairs.a.api,
      f.pairs.b.api,
      f.pairs.bridge.api,
      Feature,
    ]);
    expect(r.worker).toEqual([
      f.pairs.a.worker,
      f.pairs.b.worker,
      f.pairs.bridge.worker,
      Feature,
    ]);
    expect(f.registerRules).toHaveBeenCalledWith(new Set([f.a, f.b]));
    expect(disabledModuleKeys()).toEqual(new Set());
  });

  it('a disabled module is never imported; its bridge neither (UP-12d)', async () => {
    const f = fixture();
    const r = await composeFrom(f.c, { disable: [f.b], features: noFeatures });
    expect(f.loads.b).not.toHaveBeenCalled();
    expect(f.bridgeLoad).not.toHaveBeenCalled();
    expect(r.api).toEqual([f.pairs.a.api]);
    expect(r.worker).toEqual([f.pairs.a.worker]);
    expect(f.registerRules).toHaveBeenCalledWith(new Set([f.a]));
    expect(disabledModuleKeys()).toEqual(new Set([f.b]));
  });

  it('refuses to disable a module that an enabled module requires (UP-12)', async () => {
    const f = fixture();
    await expect(
      composeFrom(f.c, { disable: [f.a], features: noFeatures }),
    ).rejects.toThrow(`Module "${f.b}" requires "${f.a}", which is disabled`);
    expect(f.loads.b).not.toHaveBeenCalled();
  });

  it.each([
    ['a duplicate key', (a: string) => [a, a], /listed twice in disable/],
    ['an unknown key', () => ['nope'], /Unknown module "nope" in disable/],
  ])('refuses %s in disable (UP-12)', async (_name, disableOf, message) => {
    const f = fixture();
    await expect(
      composeFrom(f.c, { disable: disableOf(f.b), features: noFeatures }),
    ).rejects.toThrow(message);
    expect(f.loads.a).not.toHaveBeenCalled();
  });

  it('refuses a bridge that names an unknown module (UP-12)', async () => {
    const f = fixture({ bridgeWhen: ['ghost'] });
    await expect(composeFrom(f.c, { features: noFeatures })).rejects.toThrow(
      /Optional bridge "br\d+" names unknown module "ghost"/,
    );
  });

  it('fails when a disabled module was imported anyway (by a feature or another module)', async () => {
    const f = fixture();
    markModuleLoaded(f.b);
    await expect(
      composeFrom(f.c, { disable: [f.b], features: noFeatures }),
    ).rejects.toThrow(
      `Module "${f.b}" is disabled but was imported (by a feature or another module); enable it or remove the import`,
    );
  });

  it("fails when an enabled module's index.ts does not call markModuleLoaded", async () => {
    const f = fixture({ marks: false });
    await expect(composeFrom(f.c, { features: noFeatures })).rejects.toThrow(
      `Module "${f.a}" was loaded but its index.ts did not call markModuleLoaded('${f.a}')`,
    );
  });
});

describe('boilerplate composition constants', () => {
  it('lists the boilerplate modules in import order, with their requirements and no optional bridge yet (R-X13)', () => {
    expect(Object.keys(BOILERPLATE_MODULES)).toEqual([
      'notifications',
      'identity',
      'tenancy',
      'entitlements',
      'integrations',
      'audit',
    ]);
    expect(MODULE_REQUIRES).toEqual({
      notifications: [],
      identity: ['notifications'],
      tenancy: ['identity'],
      entitlements: ['tenancy'],
      integrations: ['tenancy'],
      audit: ['identity', 'tenancy'],
    });
    expect(OPTIONAL_BRIDGES).toEqual([]);
  });
});

describe('composeAppModules', () => {
  afterEach(() => setDisabledModuleKeys([]));

  it('runs once per process: a second call fails by name instead of re-registering the cross-module rules', async () => {
    // Tắt MỌI module nền: không module nào bị import trong process unit test, không luật nào đăng ký.
    const all = Object.keys(BOILERPLATE_MODULES).filter(
      (k): k is BoilerplateModuleKey => Object.hasOwn(BOILERPLATE_MODULES, k),
    );
    const opts = { disable: all, features: noFeatures };
    await expect(composeAppModules(opts)).resolves.toEqual(noFeatures);
    await expect(composeAppModules(opts)).rejects.toThrow(
      'composeAppModules must run once per process; import APP_MODULES from src/app.modules.ts instead',
    );
  });
});
