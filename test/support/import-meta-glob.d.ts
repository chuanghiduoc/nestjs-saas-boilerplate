/**
 * Kiểu cho `import.meta.glob` của Vite (Vitest transform file test và globalSetup bằng Vite).
 * `vite` không phải dependency trực tiếp nên `vite/client` không resolve được từ root;
 * khai báo này chép đúng overload 3 (Module generic + `eager: true`) của
 * `ImportGlobFunction` trong vite/types/importGlob.d.ts.
 */
interface ImportMeta {
  glob<M>(glob: string | string[], options: { eager: true }): Record<string, M>;
}
