import { describe, expect, it } from 'vitest';
import {
  CI_VALUES,
  containerOf,
  envOf,
  findDoc,
  helmTemplate,
  helmTemplateError,
  namesOf,
  replicasOf,
  type Overrides,
} from './support/helm.js';

const SCHEDULER = 'r-saas-app-worker-scheduler';
const DEFAULT = 'r-saas-app-worker-default';
const hot = (extra: Overrides = {}): Overrides => ({
  queues: ['notifications'],
  queuesExclude: [],
  relay: false,
  dashboard: false,
  replicas: 1,
  env: {},
  hpa: { enabled: false },
  pdb: { maxUnavailable: 1 },
  resources: {},
  ...extra,
});

describe('worker groups (spec §12.1–§12.3)', () => {
  it('scheduler consumes maintenance, runs the relay and Bull Board; default excludes maintenance, relay off', () => {
    const docs = helmTemplate();
    const s = envOf(
      containerOf(findDoc(docs, 'Deployment', SCHEDULER), 'worker'),
    );
    expect(s.get('APP_ROLE')?.value).toBe('worker');
    expect(s.get('WORKER_QUEUES')?.value).toBe('maintenance');
    expect(s.get('WORKER_QUEUES_EXCLUDE')?.value).toBe('');
    expect(s.get('OUTBOX_AUTOSTART')?.value).toBe('true');
    expect(s.get('QUEUE_DASHBOARD_ENABLED')?.value).toBe('true');
    expect(s.get('QUEUE_DASHBOARD_HOST')?.value).toBe('0.0.0.0');
    expect(s.get('QUEUE_DASHBOARD_PORT')?.value).toBe('3002');
    expect(s.get('QUEUE_DASHBOARD_IP_ALLOWLIST')?.value).toBe('127.0.0.1/32');
    expect(s.get('WORKER_HEALTH_HOST')?.value).toBe('0.0.0.0');
    expect(s.get('WORKER_HEALTH_PORT')?.value).toBe('3001');
    const d = envOf(
      containerOf(findDoc(docs, 'Deployment', DEFAULT), 'worker'),
    );
    expect(d.get('WORKER_QUEUES')?.value).toBe('');
    expect(d.get('WORKER_QUEUES_EXCLUDE')?.value).toBe('maintenance');
    expect(d.get('OUTBOX_AUTOSTART')?.value).toBe('false');
    expect(d.get('QUEUE_DASHBOARD_ENABLED')?.value).toBe('false');
    expect(d.has('QUEUE_DASHBOARD_PORT')).toBe(false);
  });

  it('probes on port health; args start the worker entrypoint; dashboard port only where enabled', () => {
    const docs = helmTemplate();
    const c = containerOf(findDoc(docs, 'Deployment', SCHEDULER), 'worker');
    expect(c.args).toEqual([
      '--import',
      './dist/instrumentation.js',
      'dist/main.worker.js',
    ]);
    expect(c.readinessProbe?.httpGet).toEqual({
      path: '/health/ready',
      port: 'health',
    });
    expect(c.livenessProbe?.httpGet).toEqual({
      path: '/health/live',
      port: 'health',
    });
    expect(c.startupProbe?.httpGet).toEqual({
      path: '/health/live',
      port: 'health',
    });
    expect(c.ports?.map((p) => p.name)).toEqual(['health', 'dashboard']);
    expect(
      containerOf(findDoc(docs, 'Deployment', DEFAULT)).ports?.map(
        (p) => p.name,
      ),
    ).toEqual(['health']);
  });

  it('with HPA the Deployment has no replicas; without, it has them', () => {
    const docs = helmTemplate();
    expect(
      replicasOf(findDoc(docs, 'Deployment', 'r-saas-app-api')),
    ).toBeUndefined();
    expect(replicasOf(findDoc(docs, 'Deployment', DEFAULT))).toBeUndefined();
    expect(replicasOf(findDoc(docs, 'Deployment', SCHEDULER))).toBe(2);
    expect(namesOf(docs, 'HorizontalPodAutoscaler')).toEqual([
      'r-saas-app-api',
      DEFAULT,
    ]);
    const hpa = findDoc(docs, 'HorizontalPodAutoscaler', 'r-saas-app-api');
    expect(hpa.spec).toMatchObject({
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'r-saas-app-api',
      },
      minReplicas: 2,
      maxReplicas: 6,
      behavior: { scaleDown: { stabilizationWindowSeconds: 300 } },
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: { type: 'Utilization', averageUtilization: 70 },
          },
        },
      ],
    });
    const off = helmTemplate({
      overrides: [{ api: { replicas: 3, hpa: { enabled: false } } }],
    });
    expect(replicasOf(findDoc(off, 'Deployment', 'r-saas-app-api'))).toBe(3);
    expect(namesOf(off, 'HorizontalPodAutoscaler')).toEqual([DEFAULT]);
    expect(
      helmTemplateError({
        overrides: [{ api: { replicas: null, hpa: { enabled: false } } }],
      }),
    ).toContain('api.replicas is required when api.hpa.enabled is false');
  });

  it('extraMetrics are copied as HPA v2 metrics; an unknown metric type is refused', () => {
    const external = {
      type: 'External',
      external: {
        metric: {
          name: 'queue_oldest_job_age_seconds',
          selector: { matchLabels: { queue: 'notifications' } },
        },
        target: { type: 'Value', value: '30' },
      },
    };
    const hpaOn = (extraMetrics: unknown[]) => ({
      workers: {
        default: {
          hpa: {
            enabled: true,
            minReplicas: 2,
            maxReplicas: 6,
            targetCPUUtilizationPercentage: 70,
            scaleDownStabilizationSeconds: 300,
            extraMetrics,
          },
        },
      },
    });
    const hpa = findDoc(
      helmTemplate({ overrides: [hpaOn([external])] }),
      'HorizontalPodAutoscaler',
      DEFAULT,
    );
    expect((hpa.spec as { metrics: unknown[] }).metrics).toEqual([
      expect.objectContaining({ type: 'Resource' }),
      external,
    ]);
    expect(
      helmTemplateError({ overrides: [hpaOn([{ type: 'Bogus' }])] }),
    ).toContain(
      "at '/workers/default/hpa/extraMetrics/0/type': value must be one of",
    );
  });

  it('one PDB per Deployment with maxUnavailable 1', () => {
    const docs = helmTemplate({ values: [CI_VALUES.split] });
    expect(namesOf(docs, 'PodDisruptionBudget')).toEqual(
      namesOf(docs, 'Deployment'),
    );
    for (const name of namesOf(docs, 'PodDisruptionBudget'))
      expect(findDoc(docs, 'PodDisruptionBudget', name).spec).toMatchObject({
        maxUnavailable: 1,
        unhealthyPodEvictionPolicy: 'AlwaysAllow',
      });
  });

  it('a bad group name is refused by the schema; an object name above 63 characters fails', () => {
    expect(
      helmTemplateError({ overrides: [{ workers: { Hot_1: hot() } }] }),
    ).toContain("invalid propertyName 'Hot_1'");
    // Helm không render template theo thứ tự chữ cái (đã thấy: worker-pdb.yaml fail trước checks.yaml), nên chỉ so tiền tố.
    const long = 'r'.repeat(40);
    expect(helmTemplateError({ release: long })).toMatch(
      /object name "r{40}-saas-app-worker-[a-z-]+" is longer than 63 characters/,
    );
    expect(() => helmTemplate({ release: 'r'.repeat(25) })).not.toThrow();
  });

  it('the dashboard Service is ClusterIP on port dashboard, only for groups with dashboard: true', () => {
    const docs = helmTemplate();
    expect(namesOf(docs, 'Service')).toEqual([
      'r-saas-app-api',
      `${SCHEDULER}-dashboard`,
    ]);
    expect(
      findDoc(docs, 'Service', `${SCHEDULER}-dashboard`).spec,
    ).toMatchObject({
      type: 'ClusterIP',
      ports: [{ name: 'dashboard', port: 3002, targetPort: 'dashboard' }],
    });
  });
});

describe('queue coverage (spec §12.1)', () => {
  it('the default values and ci/values-split-workers.yaml pass', () => {
    expect(() => helmTemplate()).not.toThrow();
    const docs = helmTemplate({ values: [CI_VALUES.split] });
    const d = envOf(containerOf(findDoc(docs, 'Deployment', DEFAULT)));
    expect(d.get('WORKER_QUEUES_EXCLUDE')?.value).toBe(
      'maintenance,notifications',
    );
    expect(
      envOf(
        containerOf(findDoc(docs, 'Deployment', 'r-saas-app-worker-hot')),
      ).get('WORKER_QUEUES')?.value,
    ).toBe('notifications');
  });
  it('no catch-all group fails', () => {
    expect(
      helmTemplateError({
        overrides: [
          {
            workers: {
              default: {
                queues: ['events', 'notifications'],
                queuesExclude: [],
              },
            },
          },
        ],
      }),
    ).toContain('workers: at least one group must have queues: []');
  });
  it('an excluded queue that no other group consumes fails', () => {
    expect(
      helmTemplateError({
        overrides: [
          {
            workers: {
              default: { queuesExclude: ['maintenance', 'notifications'] },
            },
          },
        ],
      }),
    ).toContain(
      'workers.default.queuesExclude has "notifications" but no other group consumes it',
    );
  });
  it('a hot group whose queue the catch-all group does not exclude fails (no real bulkhead)', () => {
    expect(
      helmTemplateError({ overrides: [{ workers: { hot: hot() } }] }),
    ).toContain(
      'queue "notifications" is in workers.hot.queues but workers.default consumes it too; add it to workers.default.queuesExclude',
    );
  });
  it('a group with both queues and queuesExclude fails like the app does at boot', () => {
    expect(
      helmTemplateError({
        overrides: [{ workers: { scheduler: { queuesExclude: ['events'] } } }],
      }),
    ).toContain('workers.scheduler: set queues or queuesExclude, not both');
  });
});

describe('an in-cluster dashboard needs a matching IP allowlist', () => {
  const ingressFrom = [{ podSelector: { matchLabels: { app: 'ops-proxy' } } }];
  it('ingressFrom with the loopback allowlist fails', () => {
    expect(
      helmTemplateError({ overrides: [{ dashboard: { ingressFrom } }] }),
    ).toContain(
      'dashboard.ingressFrom is set but dashboard.ipAllowlist is still 127.0.0.1/32',
    );
  });
  it('a matching allowlist passes and reaches QUEUE_DASHBOARD_IP_ALLOWLIST', () => {
    const docs = helmTemplate({
      overrides: [{ dashboard: { ingressFrom, ipAllowlist: '10.42.0.0/16' } }],
    });
    expect(
      envOf(containerOf(findDoc(docs, 'Deployment', SCHEDULER))).get(
        'QUEUE_DASHBOARD_IP_ALLOWLIST',
      )?.value,
    ).toBe('10.42.0.0/16');
  });
});
