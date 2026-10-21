import { describe, expect, it } from 'vitest';
import {
  CI_VALUES,
  containerOf,
  envNames,
  envOf,
  findDoc,
  helmNotes,
  helmTemplate,
  helmTemplateError,
  podTemplateOf,
} from './support/helm.js';

/** `helm template` luôn render revision 1; tên Job = `<fullname>-migrate<suffix>-r<revision>`. */
const JOB_BASE = 'r-saas-app-migrate';
const JOB = `${JOB_BASE}-r1`;
const HOOK_NP = JOB_BASE;
const job = (
  values: readonly string[] = [CI_VALUES.full],
  overrides: Record<string, unknown>[] = [],
) => findDoc(helmTemplate({ values, overrides }), 'Job', JOB);

describe('the migrate Job hook (spec §12.4)', () => {
  it('hook annotations keep the last Job for its logs and print them when it fails', () => {
    expect(job().metadata.annotations).toMatchObject({
      'helm.sh/hook': 'pre-install,pre-upgrade',
      'helm.sh/hook-weight': '0',
      'helm.sh/hook-delete-policy': 'before-hook-creation',
      'helm.sh/hook-output-log-policy': 'hook-failed',
      'saas-app/helm-timeout-min-seconds': '1560',
    });
    expect(job().spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 604800,
    });
    const { spec } = podTemplateOf(job());
    expect(spec).toMatchObject({
      restartPolicy: 'Never',
      serviceAccountName: 'default',
    });
  });

  it('args run the migrator without instrumentation; grace = ceil(DB_MIGRATION_STATEMENT_TIMEOUT_MS / 1000)', () => {
    expect(containerOf(job(), 'migrate').args).toEqual([
      'dist/main.migrate.js',
      'up',
    ]);
    expect(podTemplateOf(job()).spec.terminationGracePeriodSeconds).toBe(600);
    const odd = job(
      [CI_VALUES.minimal],
      [{ config: { DB_MIGRATION_STATEMENT_TIMEOUT_MS: '600001' } }],
    );
    expect(podTemplateOf(odd).spec.terminationGracePeriodSeconds).toBe(601);
  });

  it('env = APP_/LOG_/DB_ keys of config + NODE_ENV + APP_ROLE + DB CA + the migrate secrets only', () => {
    const c = containerOf(job(), 'migrate');
    const env = envOf(c);
    expect(env.get('APP_ROLE')?.value).toBe('migrate');
    expect(env.get('NODE_ENV')?.value).toBe('production');
    expect(env.get('DB_MIGRATION_HOST')?.value).toBe('postgres.data.svc');
    expect(env.get('DB_SSL_CA_PATH')?.value).toBe('/etc/saas-app/db-ca/ca.crt');
    expect(env.get('DB_OWNER_PASSWORD')?.valueFrom?.secretKeyRef).toEqual({
      name: 'saas-app-db',
      key: 'owner-password',
    });
    const secrets = c.env
      .filter((e) => e.valueFrom?.secretKeyRef)
      .map((e) => e.name);
    expect(secrets).toEqual(['DB_OWNER_PASSWORD']);
    for (const name of envNames(c))
      expect(
        ['NODE_ENV', 'DB_OWNER_PASSWORD'].includes(name) ||
          /^(APP|LOG|DB)_/.test(name),
        name,
      ).toBe(true);
    for (const no of [
      'REDIS_URL',
      'FIELD_ENCRYPTION_KEYS',
      'DB_APP_PASSWORD',
      'SMTP_HOST',
      'AUTH_BASE_URL',
      'NODE_EXTRA_CA_CERTS',
    ])
      expect(env.has(no), no).toBe(false);
    expect(c.envFrom).toBeUndefined();
  });

  it('the migrate Job never gets OTEL_* (it does not load instrumentation)', () => {
    const names = envNames(containerOf(job(), 'migrate'));
    expect(
      names.filter(
        (n) => n.startsWith('OTEL_') || ['POD_NAME', 'HOST_IP'].includes(n),
      ),
    ).toEqual([]);
  });

  it('the hook NetworkPolicy has weight -10 and allows DNS, Postgres and extra.migrate only; its selector matches the Job pod with any nameSuffix', () => {
    const docs = helmTemplate({ values: [CI_VALUES.full] });
    const np = findDoc(docs, 'NetworkPolicy', HOOK_NP);
    expect(np.metadata.annotations).toMatchObject({
      'helm.sh/hook': 'pre-install,pre-upgrade',
      'helm.sh/hook-weight': '-10',
      'helm.sh/hook-delete-policy': 'before-hook-creation',
    });
    const spec = np.spec as {
      podSelector: { matchLabels: Record<string, string> };
      ingress: unknown[];
      egress: { ports: { port: number | string }[] }[];
      policyTypes: string[];
    };
    expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(spec.ingress).toEqual([]);
    expect(spec.egress.map((r) => r.ports.map((p) => p.port))).toEqual([
      [53, 53],
      [5432],
      [9002],
    ]);
    for (const nameSuffix of ['', '-down-x']) {
      const j = findDoc(
        helmTemplate({
          values: [CI_VALUES.full],
          overrides: [{ migrate: { nameSuffix } }],
        }),
        'Job',
        `${JOB_BASE}${nameSuffix}-r1`,
      );
      const labels = podTemplateOf(j).metadata.labels;
      for (const [k, v] of Object.entries(spec.podSelector.matchLabels))
        expect(labels[k], k).toBe(v);
    }
  });

  it('migrate.args renders a manual down Job (runbook 14.3)', () => {
    const j = findDoc(
      helmTemplate({
        overrides: [
          {
            migrate: {
              args: ['down', 'Migration20261005164759_usage_counters'],
              nameSuffix: '-down-t1',
            },
          },
        ],
      }),
      'Job',
      `${JOB_BASE}-down-t1-r1`,
    );
    expect(containerOf(j).args).toEqual([
      'dist/main.migrate.js',
      'down',
      'Migration20261005164759_usage_counters',
    ]);
  });

  it('migrate.enabled: false renders neither the Job nor its NetworkPolicy', () => {
    const docs = helmTemplate({ overrides: [{ migrate: { enabled: false } }] });
    expect(docs.filter((d) => d.metadata.name.startsWith(JOB_BASE))).toEqual(
      [],
    );
  });

  it('the Job name carries the revision, so a re-run upgrade never deletes a running Job of an earlier revision; the name stays <= 63', () => {
    expect(job().metadata.name).toBe(JOB);
    // Kiểm độ dài với hậu tố dự trữ `-r999999` (helper saas-app.migrateRevisionReserve), không với `-r1` mà
    // helm template render. Release dài nhất mà chart nhận với nhóm mặc định là 27 ký tự (Service
    // `<rel>-saas-app-worker-scheduler-dashboard` = 27 + 36 = 63), nên biên đo ở 27: 27 + len('-saas-app-migrate') (17)
    // + nameSuffix + len('-r999999') (8) ≤ 63 ⇔ nameSuffix ≤ 11 ký tự.
    const release = 'a'.repeat(27);
    expect(() =>
      helmTemplate({
        release,
        overrides: [{ migrate: { nameSuffix: '-down-t1234' } }],
      }),
    ).not.toThrow();
    expect(
      helmTemplateError({
        release,
        overrides: [{ migrate: { nameSuffix: '-down-t12345' } }],
      }),
    ).toContain(
      `object name "${release}-saas-app-migrate-down-t12345-r999999" is longer than 63 characters`,
    );
  });
});

describe('the Helm timeout budget (spec §12.4)', () => {
  it('DB_MIGRATION_STATEMENT_TIMEOUT_MS must be set explicitly', () => {
    // Chuỗi rỗng = chưa đặt. (`null` trong file values của người dùng bị schema chặn trước: `got null, want string`.)
    expect(
      helmTemplateError({
        overrides: [{ config: { DB_MIGRATION_STATEMENT_TIMEOUT_MS: '' } }],
      }),
    ).toContain(
      'migrate.enabled needs config.DB_MIGRATION_STATEMENT_TIMEOUT_MS set explicitly',
    );
  });
  it.each(['10m', '600000.5', '-1', '0'])(
    'a non-integer DB_MIGRATION_STATEMENT_TIMEOUT_MS fails instead of becoming 0 (%s)',
    (raw) => {
      expect(
        helmTemplateError({
          overrides: [{ config: { DB_MIGRATION_STATEMENT_TIMEOUT_MS: raw } }],
        }),
      ).toContain(
        `config.DB_MIGRATION_STATEMENT_TIMEOUT_MS must be a positive integer of milliseconds, got "${raw}"`,
      );
    },
  );
  it('activeDeadlineSeconds must exceed G', () => {
    expect(
      helmTemplateError({
        overrides: [{ migrate: { activeDeadlineSeconds: 600 } }],
      }),
    ).toContain(
      'migrate.activeDeadlineSeconds (600) must be greater than ceil(DB_MIGRATION_STATEMENT_TIMEOUT_MS / 1000) (600)',
    );
    expect(() =>
      helmTemplate({
        overrides: [{ migrate: { activeDeadlineSeconds: 601 } }],
      }),
    ).not.toThrow();
  });
  it('NOTES.txt prints T_min = D + G + 60 and the full deploy command', () => {
    const notes = helmNotes();
    expect(notes).toContain('= 1560s');
    expect(notes).toContain(
      'helm upgrade --install r deploy/helm/saas-app -n default -f deploy/values/<env>.yaml --set image.digest=<digest> --wait --timeout 1560s',
    );
    const custom = helmNotes({
      overrides: [
        {
          config: { DB_MIGRATION_STATEMENT_TIMEOUT_MS: '60000' },
          migrate: { activeDeadlineSeconds: 300, timeoutMarginSeconds: 30 },
        },
      ],
    });
    expect(custom).toContain('= 390s');
  });
});
