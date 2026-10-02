import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          globalSetup: ['test/support/infra.global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.spec.ts'],
          globalSetup: ['test/support/infra.global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.smoke.spec.ts'],
          globalSetup: ['test/smoke/smoke.global-setup.ts'],
          setupFiles: ['test/smoke/smoke.setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'upgrade',
          include: ['test/upgrade/**/*.spec.ts'],
          globalSetup: ['test/support/infra.global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
