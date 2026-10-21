import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CI_VALUES,
  findDoc,
  helmNotes,
  helmTemplate,
  helmTemplateError,
  type K8sDoc,
} from './support/helm.js';

const Rule = z.object({
  to: z.array(z.record(z.string(), z.unknown())),
  ports: z.array(
    z.object({ protocol: z.string(), port: z.union([z.number(), z.string()]) }),
  ),
});
const Policy = z.object({
  podSelector: z.object({ matchLabels: z.record(z.string(), z.string()) }),
  policyTypes: z.array(z.string()),
  ingress: z.array(
    z.object({ from: z.array(z.unknown()), ports: z.array(z.unknown()) }),
  ),
  egress: z.array(Rule),
});
const policy = (docs: K8sDoc[], name: string) =>
  Policy.parse(findDoc(docs, 'NetworkPolicy', name).spec);
/** Rule internet của vai trò (RESILIENCE_ALLOWED_PORTS) đứng SAU rule SMTP-internet của worker: lấy rule khớp cuối cùng. */
const internet = (p: z.infer<typeof Policy>) =>
  [...p.egress]
    .reverse()
    .find((r) => JSON.stringify(r.to).includes('0.0.0.0/0'));
const portsOf = (r: z.infer<typeof Rule> | undefined) =>
  r?.ports.map((p) => p.port);
/** Cổng 9000/9001/9002 của `extra` và 3310/4318… của nhóm có tên trong ci/values-full.yaml định danh từng nhóm. */
const ruleCidrs = (p: z.infer<typeof Policy>) =>
  p.egress.flatMap((r) => r.to.map((t) => JSON.stringify(t)));

const PRIVATE_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const PRIVATE_V6 = ['::1/128', '64:ff9b::/96', 'fc00::/7', 'fe80::/10'];
/** `ci/values-full.yaml`: networkPolicy.egress.internet.exceptExtra. */
const EXTRA_V4 = '203.0.113.0/24';
const EXTRA_V6 = '2001:db8::/32';

describe('NetworkPolicy (spec §12.6)', () => {
  const full = helmTemplate({ values: [CI_VALUES.full] });

  it('enabled with an empty apiIngressFrom fails; disabled renders no policy', () => {
    expect(
      helmTemplateError({
        overrides: [{ networkPolicy: { apiIngressFrom: [] } }],
      }),
    ).toContain(
      'networkPolicy.apiIngressFrom must not be empty when networkPolicy.enabled',
    );
    const off = helmTemplate({
      overrides: [{ networkPolicy: { enabled: false } }],
    });
    expect(off.filter((d) => d.kind === 'NetworkPolicy')).toEqual([]);
  });

  it('the api policy: ingress only from apiIngressFrom on port http; Ingress and Egress both enforced', () => {
    const api = policy(full, 'r-saas-app-api');
    expect(api.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(api.podSelector.matchLabels['app.kubernetes.io/component']).toBe(
      'api',
    );
    expect(api.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'gateway' },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 'http' }],
      },
    ]);
  });

  it('the internet rule excludes every non-public range plus exceptExtra, each in its own family', () => {
    const r = internet(policy(full, 'r-saas-app-api'));
    expect(r?.to).toEqual([
      { ipBlock: { cidr: '0.0.0.0/0', except: [...PRIVATE_V4, EXTRA_V4] } },
      { ipBlock: { cidr: '::/0', except: [...PRIVATE_V6, EXTRA_V6] } },
    ]);
    const plain = internet(policy(helmTemplate(), 'r-saas-app-api'));
    expect(plain?.to).toEqual([
      { ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_V4 } },
      { ipBlock: { cidr: '::/0', except: PRIVATE_V6 } },
    ]);
  });

  it('SMTP to the internet gets its own worker-only rule; RESILIENCE_ALLOWED_PORTS is untouched', () => {
    const internetRules = (p: z.infer<typeof Policy>) =>
      p.egress
        .filter((r) => JSON.stringify(r.to).includes('0.0.0.0/0'))
        .map(portsOf);
    expect(internetRules(policy(full, 'r-saas-app-worker-default'))).toEqual([
      [465],
      [443, 8443],
    ]);
    // Scheduler chỉ consume maintenance, không gửi thư → không có rule SMTP-internet.
    expect(internetRules(policy(full, 'r-saas-app-worker-scheduler'))).toEqual([
      [443],
    ]);
    expect(internetRules(policy(full, 'r-saas-app-api'))).toEqual([[443]]);
    expect(
      helmTemplateError({
        overrides: [
          {
            networkPolicy: {
              egress: {
                smtp: {
                  rules: [],
                  internet: { ports: [70000], queues: ['notifications'] },
                },
              },
            },
          },
        ],
      }),
    ).toMatch(/smtp\/internet\/ports\/0/);
    expect(
      helmTemplateError({
        overrides: [
          {
            networkPolicy: {
              egress: {
                internet: { enabled: true, exceptExtra: ['not-a-cidr'] },
              },
            },
          },
        ],
      }),
    ).toMatch(/exceptExtra\/0/);
  });

  it('internet ports are RESILIENCE_ALLOWED_PORTS of each role (a role env overrides config)', () => {
    expect(portsOf(internet(policy(full, 'r-saas-app-api')))).toEqual([443]);
    expect(
      portsOf(internet(policy(full, 'r-saas-app-worker-default'))),
    ).toEqual([443, 8443]);
    expect(
      portsOf(internet(policy(full, 'r-saas-app-worker-scheduler'))),
    ).toEqual([443]);
  });

  it('internet enabled without RESILIENCE_ALLOWED_PORTS fails (the chart never copies the app default 80,443)', () => {
    expect(
      helmTemplateError({
        overrides: [{ config: { RESILIENCE_ALLOWED_PORTS: '' } }],
      }),
    ).toContain(
      'api: networkPolicy.egress.internet.enabled needs RESILIENCE_ALLOWED_PORTS set explicitly',
    );
    const closed = helmTemplate({
      overrides: [
        {
          config: { RESILIENCE_ALLOWED_PORTS: '' },
          networkPolicy: { egress: { internet: { enabled: false } } },
        },
      ],
    });
    expect(internet(policy(closed, 'r-saas-app-api'))).toBeUndefined();
  });

  it.each([
    ['80, 443,', [80, 443]],
    [' 443 ', [443]],
    ['443,443', [443]],
  ] as const)(
    'internet ports parse RESILIENCE_ALLOWED_PORTS exactly like the app (%j)',
    (raw, ports) => {
      const docs = helmTemplate({
        overrides: [{ config: { RESILIENCE_ALLOWED_PORTS: raw } }],
      });
      expect(portsOf(internet(policy(docs, 'r-saas-app-api')))).toEqual(ports);
    },
  );
  it.each([
    ['443,abc', '"abc", which is not a port number'],
    ['0', '"0", outside 1-65535'],
    ['70000', '"70000", outside 1-65535'],
    ['-1', '"-1", which is not a port number'],
    [',', 'RESILIENCE_ALLOWED_PORTS has no port'],
  ] as const)('values the app refuses are refused too (%j)', (raw, message) => {
    expect(
      helmTemplateError({
        overrides: [{ config: { RESILIENCE_ALLOWED_PORTS: raw } }],
      }),
    ).toContain(message);
  });

  it('named egress groups land on the roles that use them; extra is copied to the right policy', () => {
    const api = ruleCidrs(policy(full, 'r-saas-app-api'));
    const dflt = ruleCidrs(policy(full, 'r-saas-app-worker-default'));
    const sched = ruleCidrs(policy(full, 'r-saas-app-worker-scheduler'));
    const has = (list: string[], cidr: string) =>
      list.some((t) => t.includes(cidr));
    // objectStorage 10.10.3.0/24: api và mọi worker.
    for (const l of [api, dflt, sched])
      expect(has(l, '10.10.3.0/24')).toBe(true);
    // clamd (namespace av): chỉ worker.
    expect(has(api, '"av"')).toBe(false);
    expect(has(dflt, '"av"') && has(sched, '"av"')).toBe(true);
    // idp 10.20.0.0/16: api và nhóm có dashboard.
    expect(has(api, '10.20.0.0/16')).toBe(true);
    expect(has(sched, '10.20.0.0/16')).toBe(true);
    expect(has(dflt, '10.20.0.0/16')).toBe(false);
    // smtp 10.10.2.10/32 và postgres trực tiếp 10.10.0.0/24: chỉ worker, và ở MỌI nhóm worker (postgres: RelayDb ngoài relay).
    expect(has(api, '10.10.2.10/32') || has(api, '10.10.0.0/24')).toBe(false);
    expect(has(dflt, '10.10.2.10/32') && has(dflt, '10.10.0.0/24')).toBe(true);
    expect(has(sched, '10.10.0.0/24')).toBe(true);
    // extra theo vai trò.
    expect(has(api, '10.30.0.1/32') && !has(api, '10.30.0.2/32')).toBe(true);
    expect(has(dflt, '10.30.0.2/32') && !has(dflt, '10.30.0.1/32')).toBe(true);
    expect(has(dflt, '10.30.0.3/32') || has(api, '10.30.0.3/32')).toBe(false);
  });

  it('a rule of the wrong shape is refused by the schema', () => {
    expect(
      helmTemplateError({
        overrides: [
          {
            networkPolicy: {
              egress: {
                redis: [
                  {
                    to: [{ bogus: 1 }],
                    ports: [{ protocol: 'TCP', port: 6379 }],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toContain(
      "at '/networkPolicy/egress/redis/0/to/0': additional properties 'bogus' not allowed",
    );
  });

  it('the worker without a dashboard has no ingress; the dashboard group opens port dashboard only to ingressFrom', () => {
    expect(policy(full, 'r-saas-app-worker-default').ingress).toEqual([]);
    expect(policy(full, 'r-saas-app-worker-scheduler').ingress).toEqual([]);
    const open = helmTemplate({
      overrides: [
        {
          dashboard: {
            ipAllowlist: '10.42.0.0/16',
            ingressFrom: [{ podSelector: { matchLabels: { app: 'ops' } } }],
          },
        },
      ],
    });
    expect(policy(open, 'r-saas-app-worker-scheduler').ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { app: 'ops' } } }],
        ports: [{ protocol: 'TCP', port: 'dashboard' }],
      },
    ]);
  });

  it('otel enabled without an otel egress rule fails, also with endpointFromHostIP (node IPs are private)', () => {
    for (const otel of [
      {
        enabled: true,
        endpoint: 'http://collector:4318',
        endpointFromHostIP: { enabled: false, port: 4318, scheme: 'http' },
        serviceNamePrefix: '',
      },
      {
        enabled: true,
        endpoint: '',
        endpointFromHostIP: { enabled: true, port: 4318, scheme: 'http' },
        serviceNamePrefix: '',
      },
    ])
      expect(helmTemplateError({ overrides: [{ otel }] })).toContain(
        'otel.enabled with networkPolicy.enabled needs networkPolicy.egress.otel',
      );
    expect(
      helmTemplateError({
        overrides: [{ otel: { enabled: true, endpoint: '' } }],
      }),
    ).toContain(
      'otel.enabled needs otel.endpoint or otel.endpointFromHostIP.enabled',
    );
  });

  it('NOTES warns when RESILIENCE_SSRF_ALLOW_CIDRS is set (private ranges are outside the internet rule)', () => {
    expect(helmNotes({ values: [CI_VALUES.full] })).toContain(
      'WARNING: RESILIENCE_SSRF_ALLOW_CIDRS=10.20.0.0/16',
    );
    expect(helmNotes()).not.toContain('RESILIENCE_SSRF_ALLOW_CIDRS');
  });
});
