import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';
import { examplePlans } from './plans.example.js';

/**
 * Composition của dự án (vùng dự án, file hạt giống của upstream; spec SP7 §6.2). `disable`: khoá module nền không
 * dùng (module bị tắt không bao giờ được import). Feature của dự án: thêm một dòng
 * `features.api.push(XModule.forApi());` và một dòng `features.worker.push(XModule.forWorker());`.
 * Dòng kết thúc bằng `// upstream:template` thuộc vùng template: `pnpm upstream:init` xoá nguyên dòng đó.
 * Top-level await: ESM đánh giá xong file này trước khi `main.*` gọi `validateAllConfigs()`.
 */
const features: AppFeatures = { api: [], worker: [] };

export const APP_MODULES = await composeAppModules({
  disable: [],
  features,
  plans: examplePlans,
});
