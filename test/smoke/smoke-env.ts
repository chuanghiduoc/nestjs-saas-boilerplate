import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Tham số của bộ smoke (không phải config của app). Cổng cao, chỉ bind 127.0.0.1, không đụng cổng dev.
 * Project, cổng và subnet đều override được bằng biến môi trường, để hai worktree chạy smoke cùng lúc
 * (ví dụ `SMOKE_PROJECT=nsb-smoke-b SMOKE_PORT_BASE=39400 SMOKE_SUBNET=172.31.251.0/24 pnpm test:smoke`).
 */
export const DEFAULT_SMOKE_PROJECT = 'nsb-smoke';
/** Mặc định; đặt biến môi trường `SMOKE_SUBNET` khi trùng mạng có sẵn (WSL2/Docker Desktop, review M9). */
export const DEFAULT_SMOKE_SUBNET = '172.31.250.0/24';
export const DEFAULT_SMOKE_PORT_BASE = 39300;
export type SmokePorts = {
  http: number;
  db: number;
  redis: number;
  pgbouncer: number;
  mailpitUi: number;
  mailpitSmtp: number;
  dashboard: number;
  otel: number;
};
/** Số cổng liên tiếp bắt đầu từ `SMOKE_PORT_BASE` (một cổng cho mỗi khoá của `SmokePorts`). */
const SMOKE_PORT_COUNT = 8;
/** Cổng không đặc quyền đầu tiên; cổng cao nhất của TCP. */
const MIN_PORT_BASE = 1024;
const MAX_PORT = 65535;
/** Image app của smoke: cùng repo với `x-app` của compose.yaml, tag riêng theo project (không ghi đè `:local` của dev). */
const APP_IMAGE_REPO = 'nestjs-saas-boilerplate';
/** Quy tắc tên project của Compose. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const SMOKE_DB = 'app';
export const SMOKE_SUPERUSER = 'postgres';
export const SMOKE_REDIS_USER = 'app';
export const APP_EXAMPLE = '.env.example';
export const INFRA_EXAMPLE = '.env.infra.example';
/** Dấu mà `renderEnvExample` (SP1) gắn cuối dòng mô tả của khoá bắt buộc. */
const REQUIRED_MARK = '(required)';
const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const IPV4_BITS = 32;
const OCTET_SHIFTS = [24, 16, 8, 0] as const;

export const smokeSecret = (bytes = 24): string =>
  randomBytes(bytes).toString('base64url');

export type EnvExample = { values: Record<string, string>; required: string[] };
export type SmokeEnv = {
  dir: string;
  infraFile: string;
  appFile: string;
  app: Record<string, string>;
  infra: Record<string, string>;
  requiredApp: string[];
  requiredInfra: string[];
  project: string;
  ports: SmokePorts;
  appImage: string;
};

/** Đọc file example: giá trị mặc định (bỏ khoá rỗng) và danh sách khoá đánh dấu `(required)`. */
export function readEnvExample(path: string): EnvExample {
  const text = readFileSync(resolve(path), 'utf8');
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(text)))
    if (typeof v === 'string' && v !== '') values[k] = v;
  const required: string[] = [];
  let pendingRequired = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#'))
      pendingRequired = line.trimEnd().endsWith(REQUIRED_MARK);
    else if (line.includes('=')) {
      if (pendingRequired)
        required.push(line.slice(0, line.indexOf('=')).trim());
      pendingRequired = false;
    }
  }
  return { values, required };
}

export function smokeSubnet(): string {
  const v = process.env.SMOKE_SUBNET ?? DEFAULT_SMOKE_SUBNET;
  const m = CIDR_V4.exec(v);
  const octets = m ? m.slice(1, 5).map(Number) : [];
  const prefix = Number(m?.[5]);
  if (!m || octets.some((o) => o > 255) || prefix > IPV4_BITS)
    throw new Error(
      `SMOKE_SUBNET must be an IPv4 CIDR such as ${DEFAULT_SMOKE_SUBNET}, got "${v}"`,
    );
  // Docker từ chối subnet có bit host; báo sớm, kèm địa chỉ mạng đúng.
  const addr = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (IPV4_BITS - prefix);
  const network = addr - (addr % size);
  if (network !== addr) {
    const canonical = OCTET_SHIFTS.map(
      (s) => Math.floor(network / 2 ** s) % 256,
    ).join('.');
    throw new Error(
      `SMOKE_SUBNET must be a network address (no host bits), got "${v}"; use ${canonical}/${prefix}`,
    );
  }
  return v;
}

export function smokeProject(): string {
  const v = process.env.SMOKE_PROJECT ?? DEFAULT_SMOKE_PROJECT;
  if (!PROJECT_NAME.test(v))
    throw new Error(
      `SMOKE_PROJECT must match ${PROJECT_NAME} (compose project name), got "${v}"`,
    );
  return v;
}

export function smokePorts(): SmokePorts {
  const raw = process.env.SMOKE_PORT_BASE ?? String(DEFAULT_SMOKE_PORT_BASE);
  const base = Number(raw);
  const maxBase = MAX_PORT - (SMOKE_PORT_COUNT - 1);
  if (!/^\d+$/.test(raw) || base < MIN_PORT_BASE || base > maxBase)
    throw new Error(
      `SMOKE_PORT_BASE must be an integer in [${MIN_PORT_BASE}, ${maxBase}], got "${raw}"`,
    );
  return {
    http: base,
    db: base + 1,
    redis: base + 2,
    pgbouncer: base + 3,
    mailpitUi: base + 4,
    mailpitSmtp: base + 5,
    dashboard: base + 6,
    otel: base + 7,
  };
}

/**
 * File dotenv cho Compose (vừa `--env-file` nội suy vừa `env_file` của container). Giá trị bọc nháy đơn:
 * với parser của Compose, trong nháy đơn không có nội suy `$`, `#` không mở comment, `"` và khoảng trắng
 * giữ nguyên (đã kiểm bằng `docker compose config`, Compose v5.4.0). Chỉ `\'` là escape, nên giá trị
 * chứa `'`, xuống dòng hay kết thúc bằng `\` không biểu diễn chắc chắn được: ném lỗi thay vì ghi sai.
 */
export function renderEnvFile(o: Record<string, string>): string {
  return `${Object.entries(o)
    .map(([k, v]) => {
      if (/['\r\n]/.test(v) || v.endsWith('\\'))
        throw new Error(
          `smoke env: value of ${k} contains ', a newline or a trailing backslash, which the compose env file cannot quote`,
        );
      return `${k}='${v}'`;
    })
    .join('\n')}\n`;
}

/**
 * Config production của container app + biến nội suy của compose = giá trị của hai file example + ghi đè
 * của smoke. Không có khoá nào tắt luật production. Thiếu khoá do schema thêm sau này → preflight báo tên.
 */
export function buildSmokeEnv(
  extra: (s: { secret: typeof smokeSecret }) => Record<string, string>,
): SmokeEnv {
  const appExample = readEnvExample(APP_EXAMPLE);
  const infraExample = readEnvExample(INFRA_EXAMPLE);
  // Kiểm trước mkdtemp: ném sau đó sẽ bỏ lại thư mục tạm (chứa secret) không ai dọn.
  const subnet = smokeSubnet();
  const project = smokeProject();
  const ports = smokePorts();
  const appImage = `${APP_IMAGE_REPO}:${project}`;
  const redisPassword = smokeSecret();
  const app: Record<string, string> = {
    ...appExample.values,
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    DB_NAME: SMOKE_DB,
    DB_APP_PASSWORD: smokeSecret(),
    DB_RELAY_PASSWORD: smokeSecret(),
    DB_OWNER_PASSWORD: smokeSecret(),
    DB_AUTH_PASSWORD: smokeSecret(),
    DB_SSL_MODE: 'verify-full',
    DB_SSL_CA_PATH: '/certs/ca.crt',
    FIELD_ENCRYPTION_KEYS: JSON.stringify({
      s1: randomBytes(32).toString('base64'),
    }),
    FIELD_ENCRYPTION_ACTIVE_KID: 's1',
    ...extra({ secret: smokeSecret }),
  };
  const infraBase: Record<string, string> = {
    ...infraExample.values,
    POSTGRES_SUPERUSER: SMOKE_SUPERUSER,
    POSTGRES_SUPERUSER_PASSWORD: smokeSecret(),
    REDIS_PASSWORD: redisPassword,
    REDIS_APP_USER: SMOKE_REDIS_USER,
    COMPOSE_REDIS_URL: `rediss://${SMOKE_REDIS_USER}:${redisPassword}@redis:6379`,
    DB_PORT_HOST: String(ports.db),
    REDIS_PORT_HOST: String(ports.redis),
    PGBOUNCER_PORT_HOST: String(ports.pgbouncer),
    HTTP_PORT_HOST: String(ports.http),
    MAILPIT_UI_PORT_HOST: String(ports.mailpitUi),
    MAILPIT_SMTP_PORT_HOST: String(ports.mailpitSmtp),
    QUEUE_DASHBOARD_PORT_HOST: String(ports.dashboard),
    OTEL_PORT_HOST: String(ports.otel),
    SMOKE_SUBNET: subnet,
    SMOKE_APP_IMAGE: appImage,
  };
  // Render trước mkdtemp: giá trị không quote được thì ném khi chưa có gì trên đĩa.
  const appText = renderEnvFile(app);
  renderEnvFile(infraBase);
  const dir = mkdtempSync(join(tmpdir(), `${project}-`));
  const appFile = join(dir, 'app.env');
  const infraFile = join(dir, 'infra.env');
  // Compose trên Windows nhận `/`; `\` trong file dotenv là ký tự escape (review M9).
  const infra = { ...infraBase, APP_ENV_FILE: appFile.replaceAll('\\', '/') };
  writeFileSync(appFile, appText);
  writeFileSync(infraFile, renderEnvFile(infra));
  return {
    dir,
    infraFile,
    appFile,
    app,
    infra,
    requiredApp: appExample.required,
    requiredInfra: infraExample.required,
    project,
    ports,
    appImage,
  };
}
