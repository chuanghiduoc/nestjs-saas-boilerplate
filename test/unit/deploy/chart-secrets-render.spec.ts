import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SecretField } from '../../../src/core/config/index.js';
import {
  SECRET_ENV_FILE,
  VALUES_SCHEMA_FILE,
  chartSecretsDrift,
  renderChartSecrets,
} from '../../../src/scripts/chart-secrets.js';

const CLI_TIMEOUT_MS = 120_000;
const FIELDS: SecretField[] = [
  { env: 'B_SECRET', roles: ['worker'] },
  { env: 'A_SECRET', roles: ['api', 'worker'] },
];
const SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 't',
  $defs: { envName: { type: 'string' }, secretEnvName: { enum: ['OLD'] } },
});
const Schema = z
  .object({
    $defs: z
      .object({ secretEnvName: z.object({ enum: z.array(z.string()) }) })
      .passthrough(),
  })
  .passthrough();
/** `z.record` giữ thứ tự khoá của input; `object().passthrough()` đặt khoá đã khai lên trước nên không đọc được thứ tự. */
const Keyed = z.record(z.string(), z.unknown());
const keysOf = (json: string, path: 'root' | '$defs'): string[] => {
  const root = Keyed.parse(JSON.parse(json));
  return Object.keys(path === 'root' ? root : Keyed.parse(root.$defs));
};

describe('pnpm chart:secrets (HC-30, spec SP7 S7-D33)', () => {
  it('renders the allowlist and the schema enum sorted, byte-stable, idempotent, keeping the schema key order', () => {
    const out = renderChartSecrets(FIELDS, SCHEMA);
    expect(out.secretEnv).toBe(
      '{\n  "A_SECRET": [\n    "api",\n    "worker"\n  ],\n  "B_SECRET": [\n    "worker"\n  ]\n}\n',
    );
    expect(keysOf(out.valuesSchema, 'root')).toEqual([
      '$schema',
      'title',
      '$defs',
    ]);
    expect(keysOf(out.valuesSchema, '$defs')).toEqual([
      'envName',
      'secretEnvName',
    ]);
    expect(
      Schema.parse(JSON.parse(out.valuesSchema)).$defs.secretEnvName.enum,
    ).toEqual(['A_SECRET', 'B_SECRET']);
    expect(renderChartSecrets(FIELDS, out.valuesSchema)).toEqual(out);
    expect(out.valuesSchema.endsWith('}\n')).toBe(true);
  });
  it('a newly marked secret field makes --check red on both generated files', () => {
    const committed = renderChartSecrets(FIELDS, SCHEMA);
    const after = renderChartSecrets(
      [...FIELDS, { env: 'C_SECRET', roles: ['api'] }],
      SCHEMA,
    );
    expect(chartSecretsDrift(after, committed)).toEqual([
      SECRET_ENV_FILE,
      VALUES_SCHEMA_FILE,
    ]);
    expect(chartSecretsDrift(committed, committed)).toEqual([]);
  });
  it('refuses a schema without $defs and a secret declared twice', () => {
    expect(() => renderChartSecrets(FIELDS, '{}')).toThrow(
      `${VALUES_SCHEMA_FILE} must be a JSON object with a $defs object`,
    );
    expect(() =>
      renderChartSecrets(
        [...FIELDS, { env: 'A_SECRET', roles: ['api'] }],
        SCHEMA,
      ),
    ).toThrow('A_SECRET is declared as a secret twice');
  });
  it(
    'the committed chart files match the code (pnpm chart:secrets --check)',
    () => {
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          'src/scripts/gen-chart-secrets.ts',
          '--check',
        ],
        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS },
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('chart secrets up to date');
    },
    CLI_TIMEOUT_MS,
  );
  it('the committed allowlist is the table of spec §12.5 after C3', () => {
    expect(JSON.parse(readFileSync(SECRET_ENV_FILE, 'utf8'))).toEqual({
      AUTH_GOOGLE_CLIENT_SECRET: ['api'],
      AUTH_OIDC_CLIENT_SECRET: ['api'],
      BETTER_AUTH_SECRET: ['api', 'worker'],
      DB_APP_PASSWORD: ['api', 'worker'],
      DB_AUTH_PASSWORD: ['api', 'worker'],
      DB_OWNER_PASSWORD: ['migrate'],
      DB_RELAY_PASSWORD: ['worker'],
      FIELD_ENCRYPTION_KEYS: ['api', 'worker'],
      REDIS_URL: ['api', 'worker'],
      SMTP_PASSWORD: ['worker'],
    });
  });
});
