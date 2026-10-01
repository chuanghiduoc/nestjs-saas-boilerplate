import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IConfiguration } from 'dependency-cruiser';
import { afterEach, describe, expect, it } from 'vitest';

const APP_RULE = `module.exports = { forbidden: [{ name: 'app-crm-not-billing', severity: 'error', from: { path: '^src/features/crm/' }, to: { path: '^src/features/billing-ui/' } }] };\n`;
let dir: string | undefined;
function loadConfig(appRules?: string): IConfiguration {
  dir = mkdtempSync(join(tmpdir(), 'nsb-depcruise-'));
  copyFileSync('.dependency-cruiser.cjs', join(dir, '.dependency-cruiser.cjs'));
  if (appRules)
    writeFileSync(join(dir, '.dependency-cruiser.app.cjs'), appRules);
  const require = createRequire(join(dir, 'x.cjs'));
  return require('./.dependency-cruiser.cjs') as IConfiguration;
}
const names = (c: IConfiguration) => (c.forbidden ?? []).map((r) => r.name);

describe('.dependency-cruiser.app.cjs extension point (spec SP7 §6.1, M5)', () => {
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  it('without the project file the boilerplate rules are unchanged', () => {
    expect(names(loadConfig())).not.toContain('app-crm-not-billing');
  });
  it("appends the project's forbidden rules", () => {
    const base = names(loadConfig()).length;
    rmSync(dir ?? '', { recursive: true, force: true });
    const withApp = names(loadConfig(APP_RULE));
    expect(withApp).toContain('app-crm-not-billing');
    expect(withApp.length).toBe(base + 1);
  });
  it('refuses a project rule that reuses a boilerplate rule name', () => {
    expect(() =>
      loadConfig(
        `module.exports = { forbidden: [{ name: 'no-circular', from: {}, to: {} }] };\n`,
      ),
    ).toThrow(
      '.dependency-cruiser.app.cjs: rule "no-circular" already exists in the boilerplate rules',
    );
  });
  it('refuses a project file without a forbidden array', () => {
    expect(() => loadConfig('module.exports = {};\n')).toThrow(
      '.dependency-cruiser.app.cjs must export { forbidden: [...] }',
    );
  });
});
