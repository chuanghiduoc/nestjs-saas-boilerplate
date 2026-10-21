import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CHART_DIR,
  CI_VALUES,
  containerOf,
  envOf,
  findDoc,
  helmTemplate,
  helmTemplateError,
  workloadsOf,
} from './support/helm.js';

const Allowlist = z.record(
  z.string(),
  z.array(z.enum(['api', 'worker', 'migrate'])),
);
const allowlist = Allowlist.parse(
  JSON.parse(readFileSync(join(CHART_DIR, 'files/secret-env.json'), 'utf8')),
);
const ciFiles = readdirSync(join(CHART_DIR, 'ci'))
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => join(CHART_DIR, 'ci', f));
const secretNamesIn = (c: ReturnType<typeof containerOf>) =>
  c.env
    .filter((e) => e.valueFrom?.secretKeyRef)
    .map((e) => e.name)
    .sort();
const expectedFor = (role: 'api' | 'worker' | 'migrate') =>
  Object.entries(allowlist)
    .filter(([, roles]) => roles.includes(role))
    .map(([env]) => env)
    .sort();

describe('the chart never holds a secret', () => {
  it.each(ciFiles)('no kind: Secret is rendered from %s', (file) => {
    expect(
      helmTemplate({ values: [file] }).filter((d) => d.kind === 'Secret'),
    ).toEqual([]);
  });
  it('no template of the chart produces a Secret', () => {
    for (const f of readdirSync(join(CHART_DIR, 'templates')))
      expect(
        readFileSync(join(CHART_DIR, 'templates', f), 'utf8'),
        f,
      ).not.toMatch(/^kind:\s*Secret\b/m);
  });
});

describe('secret names generated from code are refused outside secretEnv', () => {
  it.each([
    ['config', { config: { DB_APP_PASSWORD: 'x' } }, 'DB_APP_PASSWORD'],
    ['config', { config: { REDIS_URL: 'redis://x' } }, 'REDIS_URL'],
    ['api.env', { api: { env: { SMTP_PASSWORD: 'x' } } }, 'SMTP_PASSWORD'],
    [
      'workers.default.env',
      { workers: { default: { env: { DB_APP_PASSWORD: 'x' } } } },
      'DB_APP_PASSWORD',
    ],
  ] as const)('%s cannot hold %s', (_where, overrides, name) => {
    expect(helmTemplateError({ overrides: [overrides] })).toContain(
      `invalid propertyName '${name}'`,
    );
  });
  it('non-secret parameters whose name looks secret are accepted', () => {
    const docs = helmTemplate({
      overrides: [
        {
          config: {
            AUTH_PASSWORD_MIN_LENGTH: '12',
            AUTH_EMAIL_TOKEN_TTL_SEC: '3600',
            AUTH_RESET_TOKEN_TTL_SEC: '3600',
            AUTH_EXTERNAL_TOKEN_COOKIE: '',
          },
        },
      ],
    });
    expect(findDoc(docs, 'ConfigMap', 'r-saas-app-config').data).toMatchObject({
      AUTH_PASSWORD_MIN_LENGTH: '12',
      AUTH_EXTERNAL_TOKEN_COOKIE: '',
    });
  });
  it('OTEL_EXPORTER_OTLP_HEADERS is refused in config and works through secretEnvExtra', () => {
    expect(
      helmTemplateError({
        overrides: [
          { config: { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x' } },
        ],
      }),
    ).toContain("invalid propertyName 'OTEL_EXPORTER_OTLP_HEADERS'");
    const docs = helmTemplate({
      overrides: [
        {
          secretEnvExtra: {
            OTEL_EXPORTER_OTLP_HEADERS: {
              secretName: 'otel',
              key: 'headers',
              roles: ['api', 'worker'],
            },
          },
        },
      ],
    });
    expect(
      envOf(containerOf(findDoc(docs, 'Deployment', 'r-saas-app-api'))).get(
        'OTEL_EXPORTER_OTLP_HEADERS',
      )?.valueFrom,
    ).toEqual({ secretKeyRef: { name: 'otel', key: 'headers' } });
  });
  it.each([
    'APP_ROLE',
    'WORKER_QUEUES',
    'OTEL_RESOURCE_ATTRIBUTES',
    'DB_SSL_CA_PATH',
  ])('the chart-owned key %s cannot be set in config', (name) => {
    expect(
      helmTemplateError({ overrides: [{ config: { [name]: 'x' } }] }),
    ).toContain(`invalid propertyName '${name}'`);
  });
  it('the schema enum is exactly the generated allowlist', () => {
    const schema = z
      .object({
        $defs: z
          .object({ secretEnvName: z.object({ enum: z.array(z.string()) }) })
          .passthrough(),
      })
      .passthrough()
      .parse(
        JSON.parse(readFileSync(join(CHART_DIR, 'values.schema.json'), 'utf8')),
      );
    expect(schema.$defs.secretEnvName.enum).toEqual(
      Object.keys(allowlist).sort(),
    );
  });
});

describe('each role receives exactly its secrets (spec §12.5)', () => {
  const docs = helmTemplate({ values: [CI_VALUES.full] });
  it('api, every worker group (Deployment) get exactly the allowlist for their role', () => {
    for (const w of workloadsOf(docs).filter((d) => d.kind === 'Deployment')) {
      const c = containerOf(w);
      const role = c.name === 'api' ? 'api' : 'worker';
      const extra = role === 'worker' ? ['REPORTS_API_TOKEN'] : [];
      expect(secretNamesIn(c), w.metadata.name).toEqual(
        [...expectedFor(role), ...extra].sort(),
      );
    }
    const api = envOf(
      containerOf(findDoc(docs, 'Deployment', 'r-saas-app-api')),
    );
    for (const no of [
      'SMTP_PASSWORD',
      'DB_OWNER_PASSWORD',
      'DB_RELAY_PASSWORD',
    ])
      expect(api.has(no), no).toBe(false);
    const worker = envOf(
      containerOf(findDoc(docs, 'Deployment', 'r-saas-app-worker-default')),
    );
    for (const no of [
      'AUTH_GOOGLE_CLIENT_SECRET',
      'AUTH_OIDC_CLIENT_SECRET',
      'DB_OWNER_PASSWORD',
    ])
      expect(worker.has(no), no).toBe(false);
    expect(worker.get('SMTP_PASSWORD')?.valueFrom?.secretKeyRef).toEqual({
      name: 'saas-app-smtp',
      key: 'password',
    });
  });
  it('roles narrow the allowlist; a role outside it fails', () => {
    const narrowed = helmTemplate({
      overrides: [
        {
          secretEnv: {
            REDIS_URL: { secretName: 's', key: 'k', roles: ['worker'] },
          },
        },
      ],
    });
    expect(
      envOf(containerOf(findDoc(narrowed, 'Deployment', 'r-saas-app-api'))).has(
        'REDIS_URL',
      ),
    ).toBe(false);
    expect(
      envOf(
        containerOf(
          findDoc(narrowed, 'Deployment', 'r-saas-app-worker-default'),
        ),
      ).has('REDIS_URL'),
    ).toBe(true);
    expect(
      helmTemplateError({
        overrides: [
          {
            secretEnv: {
              SMTP_PASSWORD: { secretName: 's', key: 'k', roles: ['api'] },
            },
          },
        ],
      }),
    ).toContain(
      'secretEnv.SMTP_PASSWORD.roles has "api", but the code gives this secret only to: worker',
    );
  });
  it('a name outside the allowlist is refused; project secrets go through secretEnvExtra', () => {
    expect(
      helmTemplateError({
        overrides: [
          { secretEnv: { FOO_TOKEN: { secretName: 's', key: 'k' } } },
        ],
      }),
    ).toContain("invalid propertyName 'FOO_TOKEN'");
    expect(
      helmTemplateError({
        overrides: [
          {
            secretEnvExtra: {
              REDIS_URL: { secretName: 's', key: 'k', roles: ['api'] },
            },
          },
        ],
      }),
    ).toContain("invalid propertyName 'REDIS_URL'");
    expect(
      helmTemplateError({
        overrides: [
          {
            config: { X_TOKEN: 'v' },
            secretEnvExtra: {
              X_TOKEN: { secretName: 's', key: 'k', roles: ['api'] },
            },
          },
        ],
      }),
    ).toContain(
      'secretEnvExtra.X_TOKEN is also set in config, api.env or workers.*.env',
    );
    expect(
      helmTemplateError({
        overrides: [
          { secretEnvExtra: { X_TOKEN: { secretName: 's', key: 'k' } } },
        ],
      }),
    ).toMatch(/missing propert(y|ies) 'roles'/);
  });
});
