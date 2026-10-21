import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';
import { z } from 'zod';

/** Helm 4.3 (test NOTES chỉ chạy được trên Helm 4: Helm 3.22 đòi cụm cho `--dry-run=client`). */
export const HELM_BIN = process.env.HELM_BIN ?? 'helm';
export const CHART_DIR = 'deploy/helm/saas-app';
export const CI_VALUES = {
  minimal: `${CHART_DIR}/ci/values-minimal.yaml`,
  full: `${CHART_DIR}/ci/values-full.yaml`,
  split: `${CHART_DIR}/ci/values-split-workers.yaml`,
  kind: `${CHART_DIR}/ci/values-kind.yaml`,
} as const;
export const RELEASE = 'r';
/** Một lần render của Helm trên máy chậm (Windows + antivirus) dưới vài giây; trần cho process treo. */
const HELM_TIMEOUT_MS = 60_000;

export type Overrides = Record<string, unknown>;
export type RenderOpts = {
  /** File values theo thứ tự `-f`; mặc định chỉ `ci/values-minimal.yaml`. */
  values?: readonly string[];
  /** Ghi đè dạng object (ghi ra file tạm, `-f` sau `values`): dễ đặt danh sách/map hơn `--set`. */
  overrides?: readonly Overrides[];
  release?: string;
  showOnly?: string;
};

const Metadata = z
  .object({
    name: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export const K8sDoc = z
  .object({ apiVersion: z.string(), kind: z.string(), metadata: Metadata })
  .passthrough();
export type K8sDoc = z.infer<typeof K8sDoc>;

const EnvVar = z.object({
  name: z.string(),
  value: z.string().optional(),
  valueFrom: z
    .object({
      secretKeyRef: z.object({ name: z.string(), key: z.string() }).optional(),
      fieldRef: z.object({ fieldPath: z.string() }).optional(),
    })
    .optional(),
});
export type EnvVar = z.infer<typeof EnvVar>;
const Probe = z.object({
  httpGet: z.object({
    path: z.string(),
    port: z.union([z.string(), z.number()]),
  }),
  periodSeconds: z.number(),
  timeoutSeconds: z.number(),
  failureThreshold: z.number(),
});
const Container = z
  .object({
    name: z.string(),
    image: z.string(),
    args: z.array(z.string()),
    env: z.array(EnvVar).default([]),
    envFrom: z
      .array(z.object({ configMapRef: z.object({ name: z.string() }) }))
      .optional(),
    ports: z
      .array(z.object({ name: z.string(), containerPort: z.number() }))
      .optional(),
    securityContext: z.object({
      readOnlyRootFilesystem: z.boolean(),
      allowPrivilegeEscalation: z.boolean(),
      privileged: z.boolean(),
      capabilities: z.object({ drop: z.array(z.string()) }),
    }),
    startupProbe: Probe.optional(),
    livenessProbe: Probe.optional(),
    readinessProbe: Probe.optional(),
    volumeMounts: z.array(
      z.object({
        name: z.string(),
        mountPath: z.string(),
        readOnly: z.boolean().optional(),
      }),
    ),
  })
  .passthrough();
export type Container = z.infer<typeof Container>;
const PodSpec = z
  .object({
    serviceAccountName: z.string(),
    automountServiceAccountToken: z.boolean().optional(),
    enableServiceLinks: z.boolean().optional(),
    terminationGracePeriodSeconds: z.number(),
    securityContext: z.object({
      runAsNonRoot: z.boolean(),
      runAsUser: z.number(),
      runAsGroup: z.number(),
      seccompProfile: z.object({ type: z.string() }),
    }),
    containers: z.array(Container),
    volumes: z.array(
      z
        .object({
          name: z.string(),
          emptyDir: z.object({ sizeLimit: z.string() }).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type PodSpec = z.infer<typeof PodSpec>;
const PodTemplate = z.object({
  metadata: z.object({
    labels: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: PodSpec,
});
export type PodTemplate = z.infer<typeof PodTemplate>;
const WorkloadSpec = z
  .object({ template: PodTemplate, replicas: z.number().optional() })
  .passthrough();

export function helmRun(argv: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(HELM_BIN, argv, {
    encoding: 'utf8',
    timeout: HELM_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Ghi đè thành file tạm; thư mục tạm bị xoá ở mọi nhánh. */
function withValueArgs<T>(opts: RenderOpts, fn: (args: string[]) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'saas-chart-'));
  try {
    const files = (opts.overrides ?? []).map((o, i) => {
      const f = join(dir, `override-${i}.yaml`);
      writeFileSync(f, stringify(o));
      return f;
    });
    return fn(
      [...(opts.values ?? [CI_VALUES.minimal]), ...files].flatMap((f) => [
        '-f',
        f,
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function templateArgs(opts: RenderOpts, valueArgs: string[]): string[] {
  return [
    'template',
    opts.release ?? RELEASE,
    CHART_DIR,
    ...valueArgs,
    ...(opts.showOnly ? ['--show-only', opts.showOnly] : []),
  ];
}

export function docsOf(text: string): K8sDoc[] {
  return parseAllDocuments(text)
    .map((d) => d.toJS() as unknown)
    .filter((d) => d !== null && d !== undefined)
    .map((d) => K8sDoc.parse(d));
}

export function helmTemplate(opts: RenderOpts = {}): K8sDoc[] {
  return withValueArgs(opts, (valueArgs) => {
    const r = helmRun(templateArgs(opts, valueArgs));
    if (r.status !== 0) throw new Error(`helm template failed: ${r.stderr}`);
    return docsOf(r.stdout);
  });
}

/** Render phải fail; trả stderr để test so thông điệp. */
export function helmTemplateError(opts: RenderOpts = {}): string {
  return withValueArgs(opts, (valueArgs) => {
    const r = helmRun(templateArgs(opts, valueArgs));
    if (r.status === 0)
      throw new Error('helm template succeeded, but a failure was expected');
    return r.stderr;
  });
}

export function helmLint(opts: RenderOpts & { bin?: string } = {}): {
  status: number | null;
  output: string;
} {
  return withValueArgs(opts, (valueArgs) => {
    const r = spawnSync(
      opts.bin ?? HELM_BIN,
      ['lint', '--strict', CHART_DIR, ...valueArgs],
      { encoding: 'utf8', timeout: HELM_TIMEOUT_MS },
    );
    if (r.error) throw r.error;
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  });
}

/** NOTES.txt qua `install --dry-run=client` với KUBECONFIG trỏ file không tồn tại (Helm 4.3 không cần cụm). */
export function helmNotes(opts: RenderOpts = {}): string {
  return withValueArgs(opts, (valueArgs) => {
    const dir = mkdtempSync(join(tmpdir(), 'saas-notes-'));
    try {
      const r = spawnSync(
        HELM_BIN,
        [
          'install',
          opts.release ?? RELEASE,
          CHART_DIR,
          ...valueArgs,
          '--dry-run=client',
        ],
        {
          encoding: 'utf8',
          timeout: HELM_TIMEOUT_MS,
          env: { ...process.env, KUBECONFIG: join(dir, 'no-cluster') },
        },
      );
      if (r.error) throw r.error;
      if (r.status !== 0)
        throw new Error(`helm install --dry-run failed: ${r.stderr}`);
      const at = r.stdout.indexOf('NOTES:');
      if (at < 0) throw new Error('helm install --dry-run printed no NOTES');
      return r.stdout.slice(at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

export function findDoc(docs: K8sDoc[], kind: string, name: string): K8sDoc {
  const d = docs.find((x) => x.kind === kind && x.metadata.name === name);
  if (!d)
    throw new Error(
      `no ${kind} ${name}; rendered: ${docs.map((x) => `${x.kind}/${x.metadata.name}`).join(', ')}`,
    );
  return d;
}
export const namesOf = (docs: K8sDoc[], kind: string): string[] =>
  docs
    .filter((d) => d.kind === kind)
    .map((d) => d.metadata.name)
    .sort();
/** Mọi tài nguyên có pod template (Deployment, Job). */
export const workloadsOf = (docs: K8sDoc[]): K8sDoc[] =>
  docs.filter((d) => d.kind === 'Deployment' || d.kind === 'Job');

export function podTemplateOf(doc: K8sDoc): PodTemplate {
  return WorkloadSpec.parse(doc.spec).template;
}
export function replicasOf(doc: K8sDoc): number | undefined {
  return WorkloadSpec.parse(doc.spec).replicas;
}
export function containerOf(doc: K8sDoc, name?: string): Container {
  const cs = podTemplateOf(doc).spec.containers;
  const c = name ? cs.find((x) => x.name === name) : cs[0];
  if (!c)
    throw new Error(`no container ${name ?? '[0]'} in ${doc.metadata.name}`);
  return c;
}
export function envOf(c: Container): Map<string, EnvVar> {
  return new Map(c.env.map((e) => [e.name, e]));
}
export const envNames = (c: Container): string[] => c.env.map((e) => e.name);
