import { describe, expect, it } from 'vitest';
import {
  CI_VALUES,
  containerOf,
  envNames,
  envOf,
  findDoc,
  helmTemplate,
  helmTemplateError,
  podTemplateOf,
  workloadsOf,
  type K8sDoc,
} from './support/helm.js';

const API = 'r-saas-app-api';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const configMapData = (docs: K8sDoc[]) =>
  findDoc(docs, 'ConfigMap', 'r-saas-app-config').data;

describe('chart pods follow spec §13.3 and PSA restricted', () => {
  const fixtures = [CI_VALUES.minimal, CI_VALUES.full];

  it.each(fixtures)('every pod spec of %s is locked down', (file) => {
    const workloads = workloadsOf(helmTemplate({ values: [file] }));
    expect(workloads.length).toBeGreaterThan(0);
    for (const w of workloads) {
      const { spec } = podTemplateOf(w);
      expect(spec.securityContext, w.metadata.name).toEqual({
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        seccompProfile: { type: 'RuntimeDefault' },
      });
      expect(spec.automountServiceAccountToken, w.metadata.name).toBe(false);
      expect(spec.enableServiceLinks, w.metadata.name).toBe(false);
      for (const key of ['hostNetwork', 'hostPID', 'hostIPC'])
        expect(spec[key], `${w.metadata.name} ${key}`).toBeUndefined();
      for (const v of spec.volumes)
        expect('hostPath' in v, `${w.metadata.name} ${v.name}`).toBe(false);
      expect(spec.volumes.find((v) => v.name === 'tmp')?.emptyDir).toEqual({
        sizeLimit: '64Mi',
      });
      for (const c of spec.containers) {
        expect(c.securityContext, `${w.metadata.name}/${c.name}`).toEqual({
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          privileged: false,
          capabilities: { drop: ['ALL'] },
        });
        expect(c.volumeMounts).toContainEqual({
          name: 'tmp',
          mountPath: '/tmp',
        });
      }
    }
  });

  it('the api container: APP_ROLE, HTTP_HOST/PORT, args of the image ENTRYPOINT node, the shared ConfigMap, probes on port http', () => {
    const docs = helmTemplate();
    const api = findDoc(docs, 'Deployment', API);
    const c = containerOf(api, 'api');
    expect(c.args).toEqual([
      '--import',
      './dist/instrumentation.js',
      'dist/main.api.js',
    ]);
    const env = envOf(c);
    expect(env.get('APP_ROLE')?.value).toBe('api');
    expect(env.get('HTTP_HOST')?.value).toBe('0.0.0.0');
    expect(env.get('HTTP_PORT')?.value).toBe('3000');
    expect(c.envFrom).toEqual([
      { configMapRef: { name: 'r-saas-app-config' } },
    ]);
    expect(c.ports).toEqual([
      expect.objectContaining({ name: 'http', containerPort: 3000 }),
    ]);
    expect(c.startupProbe?.httpGet).toEqual({
      path: '/health/live',
      port: 'http',
    });
    expect(c.livenessProbe?.httpGet).toEqual({
      path: '/health/live',
      port: 'http',
    });
    expect(c.readinessProbe?.httpGet).toEqual({
      path: '/health/ready',
      port: 'http',
    });
    for (const p of [c.startupProbe, c.livenessProbe, c.readinessProbe])
      expect(p?.timeoutSeconds).toBeGreaterThanOrEqual(1);
    expect(podTemplateOf(api).spec.terminationGracePeriodSeconds).toBe(30);
  });

  it('a probe timeout below 1 s is refused by the schema', () => {
    expect(
      helmTemplateError({
        overrides: [
          {
            api: {
              probes: {
                readiness: {
                  periodSeconds: 5,
                  timeoutSeconds: 0,
                  failureThreshold: 2,
                },
              },
            },
          },
        ],
      }),
    ).toMatch(/timeoutSeconds/);
  });

  it('APP_SHUTDOWN_TIMEOUT_MS at or above the grace period fails, in config or in a role env', () => {
    expect(
      helmTemplateError({
        overrides: [{ config: { APP_SHUTDOWN_TIMEOUT_MS: '30000' } }],
      }),
    ).toContain(
      'api: APP_SHUTDOWN_TIMEOUT_MS (30000) must be below terminationGracePeriodSeconds x 1000 (30000)',
    );
    expect(
      helmTemplateError({
        overrides: [
          {
            workers: { default: { env: { APP_SHUTDOWN_TIMEOUT_MS: '31000' } } },
          },
        ],
      }),
    ).toContain('workers.default: APP_SHUTDOWN_TIMEOUT_MS (31000)');
    expect(() =>
      helmTemplate({
        overrides: [{ config: { APP_SHUTDOWN_TIMEOUT_MS: '29999' } }],
      }),
    ).not.toThrow();
  });

  it('checksum/config changes with the config, not with the image', () => {
    const sum = (overrides: Record<string, unknown>[]) =>
      podTemplateOf(findDoc(helmTemplate({ overrides }), 'Deployment', API))
        .metadata.annotations?.['checksum/config'];
    const base = sum([]);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(sum([{ image: { digest: DIGEST } }])).toBe(base);
    expect(sum([{ config: { LOG_LEVEL: 'debug' } }])).not.toBe(base);
  });

  it('labels and the selector do not change with the image; component names the role', () => {
    const render = (digest: string) =>
      findDoc(
        helmTemplate({ overrides: [{ image: { digest } }] }),
        'Deployment',
        API,
      );
    const a = render(DIGEST);
    const b = render(`sha256:${'b'.repeat(64)}`);
    expect(a.metadata.labels).toEqual(b.metadata.labels);
    expect(a.spec).toHaveProperty('selector.matchLabels', {
      'app.kubernetes.io/name': 'saas-app',
      'app.kubernetes.io/instance': 'r',
      'app.kubernetes.io/component': 'api',
    });
    expect(b.spec).toHaveProperty(
      'selector',
      (a.spec as { selector: unknown }).selector,
    );
    expect(a.metadata.labels).toMatchObject({
      'app.kubernetes.io/part-of': 'saas-app',
      'app.kubernetes.io/managed-by': 'Helm',
      'app.kubernetes.io/version': '0.1.0',
    });
  });

  it('digest wins over tag; tag alone works; neither fails; a malformed digest is refused', () => {
    const image = (overrides: Record<string, unknown>[]) =>
      containerOf(findDoc(helmTemplate({ overrides }), 'Deployment', API))
        .image;
    expect(image([{ image: { digest: DIGEST, tag: 'v1.2.3' } }])).toBe(
      `ghcr.io/example-owner/example-repo@${DIGEST}`,
    );
    expect(image([{ image: { digest: '', tag: 'v1.2.3' } }])).toBe(
      'ghcr.io/example-owner/example-repo:v1.2.3',
    );
    expect(
      helmTemplateError({ overrides: [{ image: { digest: '', tag: '' } }] }),
    ).toContain('image: set image.digest (production) or image.tag');
    expect(
      helmTemplateError({ overrides: [{ image: { digest: 'sha256:abc' } }] }),
    ).toMatch(/digest/);
    expect(
      helmTemplateError({ overrides: [{ image: { digest: 'a'.repeat(64) } }] }),
    ).toMatch(/digest/);
  });

  it('OTel env from the downward API, declared before use; endpoint from the node IP; nothing when disabled', () => {
    const off = envNames(
      containerOf(findDoc(helmTemplate(), 'Deployment', API)),
    );
    expect(off.filter((n) => n.startsWith('OTEL_'))).toEqual([]);
    const docs = helmTemplate({
      overrides: [
        {
          otel: {
            enabled: true,
            endpointFromHostIP: { enabled: true, port: 4318, scheme: 'http' },
            serviceNamePrefix: 'saas',
          },
          networkPolicy: {
            egress: {
              otel: [
                {
                  to: [{ ipBlock: { cidr: '10.0.0.0/16' } }],
                  ports: [{ protocol: 'TCP', port: 4318 }],
                },
              ],
            },
          },
        },
      ],
    });
    const c = containerOf(findDoc(docs, 'Deployment', API));
    const names = envNames(c);
    const env = envOf(c);
    expect(env.get('OTEL_ENABLED')?.value).toBe('true');
    expect(env.get('OTEL_SERVICE_NAME')?.value).toBe('saas-api');
    expect(env.get('OTEL_EXPORTER_OTLP_ENDPOINT')?.value).toBe(
      'http://$(HOST_IP):4318',
    );
    expect(env.get('HOST_IP')?.valueFrom?.fieldRef?.fieldPath).toBe(
      'status.hostIP',
    );
    expect(env.get('OTEL_RESOURCE_ATTRIBUTES')?.value).toBe(
      'k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),k8s.pod.uid=$(POD_UID),deployment.environment.name=ci,app.role=api',
    );
    // Kubernetes chỉ thay $(VAR) đã khai TRƯỚC biến dùng nó.
    for (const v of ['POD_NAME', 'POD_NAMESPACE', 'POD_UID', 'HOST_IP'])
      expect(names.indexOf(v), v).toBeLessThan(
        names.indexOf('OTEL_RESOURCE_ATTRIBUTES'),
      );
    expect(names.indexOf('HOST_IP')).toBeLessThan(
      names.indexOf('OTEL_EXPORTER_OTLP_ENDPOINT'),
    );
  });

  it('the ServiceAccount does not mount a token, and the ConfigMap carries config as strings', () => {
    const docs = helmTemplate({
      overrides: [{ config: { LOG_LEVEL: 'info' } }],
    });
    expect(findDoc(docs, 'ServiceAccount', 'r-saas-app')).toHaveProperty(
      'automountServiceAccountToken',
      false,
    );
    expect(configMapData(docs)).toEqual({
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: '600000',
      LOG_LEVEL: 'info',
      RESILIENCE_ALLOWED_PORTS: '443',
    });
  });
});

describe('values the schema refuses', () => {
  it('non-string env values are refused by the schema with the key path', () => {
    for (const [where, overrides] of [
      ['/config/DB_POOL_MAX', { config: { DB_POOL_MAX: 10 } }],
      [
        '/api/env/HTTP_DOCS_ENABLED',
        { api: { env: { HTTP_DOCS_ENABLED: true } } },
      ],
    ] as const)
      expect(helmTemplateError({ overrides: [overrides] })).toContain(
        `at '${where}': got`,
      );
  });
  it('env names that envFrom would silently drop are refused', () => {
    for (const bad of ['db-host', 'Db_Host', '2FA_X', 'DB HOST'])
      expect(
        helmTemplateError({ overrides: [{ config: { [bad]: 'x' } }] }),
      ).toContain(`invalid propertyName '${bad}'`);
  });
  it('unknown top-level keys are refused (additionalProperties: false)', () => {
    expect(helmTemplateError({ overrides: [{ replicas: 3 }] })).toMatch(
      /additional properties 'replicas' not allowed/,
    );
  });
});
