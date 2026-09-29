import type { DynamicModule, Type } from '@nestjs/common';
import { registerCompositionRules } from './composition.config.js';
import { loadedModules } from './core/config/index.js';
import { setDisabledModuleKeys } from './core/scheduler/index.js';

export type ModuleImport = Type<unknown> | DynamicModule;
export type ModulePair = { api: ModuleImport; worker: ModuleImport };
export type AppFeatures = { api: ModuleImport[]; worker: ModuleImport[] };
export type ComposeOptions<K extends string> = {
  /** Module nền dự án không dùng: không bao giờ được import, nên config, luật, queue, job, cron của nó không đăng ký. */
  disable?: readonly K[];
  features: AppFeatures;
};
export type ModuleEntry<K extends string> = {
  load: (opts: ComposeOptions<K>) => Promise<ModulePair>;
};
/** Cầu nối nạp khi MỌI module trong `when` cùng bật (R-X13). Không có config/queue/job/cron, không gọi markModuleLoaded. */
export type OptionalBridge<K extends string> = {
  key: string;
  when: readonly K[];
  load: () => Promise<ModulePair>;
};
export type Composition<K extends string> = {
  modules: Readonly<Record<K, ModuleEntry<K>>>;
  requires: Readonly<Record<K, readonly K[]>>;
  bridges: readonly OptionalBridge<K>[];
  registerRules: (enabled: ReadonlySet<K>) => void;
};

/**
 * Module nền của boilerplate (vùng boilerplate, spec SP7 §6.2, S7-D7). Mỗi mục là một loader: import một module là
 * đăng ký trạng thái toàn cục của nó, nên module bị tắt chỉ thật sự tắt khi không bao giờ được import. Thứ tự là thứ
 * tự import có nghĩa (module sau có thể dùng cổng của module trước). Module của SP sau thêm mục của mình ở đây, cùng
 * dòng `MODULE_REQUIRES` và `markModuleLoaded('<m>')` ở dòng đầu `index.ts` (R-X16).
 */
export const BOILERPLATE_MODULES = {
  notifications: {
    load: async () => {
      const m = await import('./modules/notifications/index.js');
      return {
        api: m.NotificationsModule.forApi(),
        worker: m.NotificationsModule.forWorker(),
      };
    },
  },
  identity: {
    load: async () => {
      const m = await import('./modules/identity/index.js');
      return {
        api: m.IdentityModule.forApi(),
        worker: m.IdentityModule.forWorker(),
      };
    },
  },
  tenancy: {
    load: async () => {
      const m = await import('./modules/tenancy/index.js');
      return {
        api: m.TenancyModule.forApi(),
        worker: m.TenancyModule.forWorker(),
      };
    },
  },
} as const satisfies Record<string, ModuleEntry<string>>;

export type BoilerplateModuleKey = keyof typeof BOILERPLATE_MODULES;

/** Module bật thì mọi module nó cần phải bật (spec SP7 §6.2 bước 1). */
export const MODULE_REQUIRES = {
  notifications: [],
  identity: ['notifications'],
  tenancy: ['identity'],
} as const satisfies Record<
  BoilerplateModuleKey,
  readonly BoilerplateModuleKey[]
>;

/** Cầu nối tuỳ chọn (R-X13). Rỗng ở 7A; SP4 4B thêm dòng `entitlements-files`. Entry của cầu nối chỉ import từ đây. */
export const OPTIONAL_BRIDGES: readonly OptionalBridge<BoilerplateModuleKey>[] =
  [];

/**
 * Dựng danh sách module của hai vai trò (spec SP7 §6.2, các bước 1–5). Export để test chạy với composition fixture
 * (UP-12b, UP-12d); ứng dụng chỉ gọi `composeAppModules`.
 */
export async function composeFrom<K extends string>(
  c: Composition<K>,
  opts: ComposeOptions<K>,
): Promise<AppFeatures> {
  const isKey = (k: string): k is K => Object.hasOwn(c.modules, k);
  const keys = Object.keys(c.modules).filter(isKey);
  // 1. Kiểm tra trước khi import bất cứ gì.
  const disabled = new Set<K>();
  for (const k of opts.disable ?? []) {
    if (!isKey(k))
      throw new Error(
        `Unknown module "${k}" in disable; known modules: ${keys.join(', ')}`,
      );
    if (disabled.has(k))
      throw new Error(`Module "${k}" is listed twice in disable`);
    disabled.add(k);
  }
  const enabled = new Set(keys.filter((k) => !disabled.has(k)));
  for (const k of enabled)
    for (const r of c.requires[k]) {
      if (!isKey(r))
        throw new Error(`Module "${k}" requires unknown module "${r}"`);
      if (!enabled.has(r))
        throw new Error(
          `Module "${k}" requires "${r}", which is disabled; disable "${k}" too or enable "${r}"`,
        );
    }
  const bridgeKeys = new Set<string>();
  for (const b of c.bridges) {
    if (bridgeKeys.has(b.key))
      throw new Error(`Optional bridge "${b.key}" is defined twice`);
    bridgeKeys.add(b.key);
    for (const w of b.when)
      if (!isKey(w))
        throw new Error(
          `Optional bridge "${b.key}" names unknown module "${w}"`,
        );
  }
  // 2. Module đang bật, tuần tự theo thứ tự khai báo; 2b. cầu nối có đủ module của nó.
  const api: ModuleImport[] = [];
  const worker: ModuleImport[] = [];
  for (const k of keys) {
    if (!enabled.has(k)) continue;
    const pair = await c.modules[k].load(opts);
    api.push(pair.api);
    worker.push(pair.worker);
  }
  for (const b of c.bridges) {
    if (!b.when.every((w) => enabled.has(w))) continue;
    const pair = await b.load();
    api.push(pair.api);
    worker.push(pair.worker);
  }
  // 3. Luật config chéo module theo tập module bật.
  c.registerRules(enabled);
  // 4. Không module tắt nào đã bị import; mọi module bật đã tự đánh dấu.
  const loaded = loadedModules();
  for (const m of loaded)
    if (isKey(m) && !enabled.has(m))
      throw new Error(
        `Module "${m}" is disabled but was imported (by a feature or another module); enable it or remove the import`,
      );
  for (const k of enabled)
    if (!loaded.has(k))
      throw new Error(
        `Module "${k}" was loaded but its index.ts did not call markModuleLoaded('${k}')`,
      );
  // 5. Cron tĩnh của module tắt sẽ được StaticScheduler gỡ.
  setDisabledModuleKeys([...disabled]);
  return {
    api: [...api, ...opts.features.api],
    worker: [...worker, ...opts.features.worker],
  };
}

let appComposed = false;

/**
 * Composition của ứng dụng: module nền của boilerplate + cầu nối + feature của dự án. Chạy đúng một lần mỗi process
 * (top-level await của `src/app.modules.ts`; ESM chỉ đánh giá file đó một lần): lần hai sẽ đăng ký lại luật chéo module
 * (`defineConfigRule` ném khi trùng tên) và ghi đè tập module tắt, nên ném có tên ngay từ đầu.
 */
export async function composeAppModules(
  opts: ComposeOptions<BoilerplateModuleKey>,
): Promise<AppFeatures> {
  if (appComposed)
    throw new Error(
      'composeAppModules must run once per process; import APP_MODULES from src/app.modules.ts instead',
    );
  // Kiểm tham số bắt buộc của module nền (công thức Step 6) đặt ở đây, TRƯỚC dòng dưới: kiểm không có tác dụng phụ.
  appComposed = true;
  return composeFrom<BoilerplateModuleKey>(
    {
      modules: BOILERPLATE_MODULES,
      requires: MODULE_REQUIRES,
      bridges: OPTIONAL_BRIDGES,
      registerRules: registerCompositionRules,
    },
    opts,
  );
}
