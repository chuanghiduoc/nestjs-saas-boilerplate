import { execFileSync, spawnSync } from 'node:child_process';
import type { SmokeEnv } from './smoke-env.js';

/** Service app nhận config qua `env_file`; mọi khoá `(required)` của `.env.example` phải có giá trị ở đây. */
const APP_SERVICES = ['api', 'worker', 'migrate'] as const;
/** Đặt bởi chính process (`main.api.ts`, `main.worker.ts`, `main.migrate.ts`), không đến từ env. */
const SET_BY_PROCESS = new Set(['APP_ROLE']);
/** Qua pipe (không TTY) compose in logfmt, nên dấu `"` quanh tên biến bị escape thành `\"`. */
const UNSET_WARNING = /The \\?"(\w+)\\?" variable is not set/g;
const CIDR = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/;

export class SmokePreflightError extends Error {}

export type RenderedCompose = {
  services: Record<string, { environment?: Record<string, string | null> }>;
};

/** Hàm thuần (unit test được): tên biến thiếu theo từng nguồn. Rỗng = đủ. */
export function missingSmokeVariables(
  env: Pick<SmokeEnv, 'infra' | 'requiredApp' | 'requiredInfra'>,
  rendered: RenderedCompose,
  composeStderr: string,
): string[] {
  const missing = new Set<string>();
  for (const m of composeStderr.matchAll(UNSET_WARNING))
    missing.add(`${m[1]} (compose interpolation)`);
  for (const k of env.requiredInfra)
    if (!env.infra[k]) missing.add(`${k} (.env.infra)`);
  for (const svc of APP_SERVICES) {
    const e = rendered.services[svc]?.environment ?? {};
    for (const k of env.requiredApp)
      if (!SET_BY_PROCESS.has(k) && !e[k]) missing.add(`${k} (service ${svc})`);
  }
  return [...missing].sort();
}

const toRange = (cidr: string): [number, number] | undefined => {
  const m = CIDR.exec(cidr);
  if (!m) return undefined;
  const base = m.slice(1, 5).reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(m[5]));
  const start = base - (base % size);
  return [start, start + size - 1];
};
/** Subnet của smoke không được chồng subnet của network Docker khác (compose báo "Pool overlaps" rất khó đọc). */
export function overlappingSubnets(
  subnet: string,
  existing: readonly string[],
): string[] {
  const mine = toRange(subnet);
  if (!mine) return [];
  return existing.filter((c) => {
    const r = toRange(c);
    return r !== undefined && r[0] <= mine[1] && mine[0] <= r[1];
  });
}

/** Thu hẹp output JSON của `docker compose config` mà không cast. */
function toRendered(v: unknown): RenderedCompose {
  if (
    typeof v !== 'object' ||
    v === null ||
    !('services' in v) ||
    typeof v.services !== 'object' ||
    v.services === null
  )
    throw new SmokePreflightError(
      'smoke preflight: unexpected `docker compose config` output',
    );
  const services: RenderedCompose['services'] = {};
  for (const [name, svc] of Object.entries(v.services)) {
    const env: Record<string, string | null> = {};
    if (
      typeof svc === 'object' &&
      svc !== null &&
      'environment' in svc &&
      typeof svc.environment === 'object' &&
      svc.environment !== null
    )
      for (const [k, val] of Object.entries(svc.environment))
        env[k] = typeof val === 'string' ? val : null;
    services[name] = { environment: env };
  }
  return { services };
}

export function assertSmokePreflight(
  env: SmokeEnv,
  composeArgs: string[],
): void {
  // `config` nội suy y như `up` nhưng không tạo gì; cảnh báo "variable is not set" nằm ở stderr.
  const r = spawnSync(
    'docker',
    [...composeArgs, '--profile', 'app', 'config', '--format', 'json'],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0)
    throw new SmokePreflightError(
      `smoke preflight: docker compose config failed:\n${r.error?.message ?? r.stderr}`,
    );
  const missing = missingSmokeVariables(
    env,
    toRendered(JSON.parse(r.stdout)),
    r.stderr,
  );
  if (missing.length)
    throw new SmokePreflightError(
      `smoke preflight: required variables missing or empty:\n  - ${missing.join('\n  - ')}\nFix: add the key to the config schema and run \`pnpm env:example\`, or give it a smoke value in test/smoke/smoke-env.ts / smoke-app-env.ts.`,
    );
  // Network của chính project smoke (lần chạy trước bị ngắt) không tính là trùng: setup xoá nó bằng
  // `down -v --remove-orphans` ngay sau preflight, trước `docker build`.
  const ids = execFileSync(
    'docker',
    ['network', 'ls', '--format', '{{.ID}} {{.Name}}'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
    .filter(([, name]) => name !== `${env.project}_default`)
    .map(([id]) => id ?? '');
  const subnets = ids.length
    ? execFileSync(
        'docker',
        [
          'network',
          'inspect',
          '--format',
          '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
          ...ids,
        ],
        { encoding: 'utf8' },
      )
        .split(/\s+/)
        .filter(Boolean)
    : [];
  const subnet = env.infra.SMOKE_SUBNET ?? '';
  const clash = overlappingSubnets(subnet, subnets);
  if (clash.length)
    throw new SmokePreflightError(
      `smoke preflight: SMOKE_SUBNET ${subnet} overlaps existing Docker networks (${clash.join(', ')}). Set a free /24, e.g. SMOKE_SUBNET=172.31.251.0/24 pnpm test:smoke`,
    );
}
