import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Tham số của bộ smoke (không phải config của app). Cổng cao, chỉ bind 127.0.0.1, không đụng cổng dev. */
export const SMOKE_PROJECT = 'nsb-smoke';
/** Mặc định; đặt biến môi trường `SMOKE_SUBNET` khi trùng mạng có sẵn (WSL2/Docker Desktop, review M9). */
export const DEFAULT_SMOKE_SUBNET = '172.31.250.0/24';
export const SMOKE_PORTS = {
  http: 39300,
  db: 39301,
  redis: 39302,
  pgbouncer: 39303,
  mailpitUi: 39304,
  mailpitSmtp: 39305,
  dashboard: 39306,
  otel: 39307,
} as const;
export const SMOKE_DB = 'app';
export const SMOKE_SUPERUSER = 'postgres';
export const SMOKE_REDIS_USER = 'app';
export const APP_EXAMPLE = '.env.example';
export const INFRA_EXAMPLE = '.env.infra.example';
/** Dấu mà `renderEnvExample` (SP1) gắn cuối dòng mô tả của khoá bắt buộc. */
const REQUIRED_MARK = '(required)';
const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

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
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32)
    throw new Error(
      `SMOKE_SUBNET must be an IPv4 CIDR such as ${DEFAULT_SMOKE_SUBNET}, got "${v}"`,
    );
  return v;
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
  // Kiểm trước mkdtemp: ném sau đó sẽ bỏ lại thư mục tạm không ai dọn.
  const subnet = smokeSubnet();
  const dir = mkdtempSync(join(tmpdir(), 'nsb-smoke-'));
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
  const appFile = join(dir, 'app.env');
  const infraFile = join(dir, 'infra.env');
  const infra: Record<string, string> = {
    ...infraExample.values,
    POSTGRES_SUPERUSER: SMOKE_SUPERUSER,
    POSTGRES_SUPERUSER_PASSWORD: smokeSecret(),
    REDIS_PASSWORD: redisPassword,
    REDIS_APP_USER: SMOKE_REDIS_USER,
    COMPOSE_REDIS_URL: `rediss://${SMOKE_REDIS_USER}:${redisPassword}@redis:6379`,
    DB_PORT_HOST: String(SMOKE_PORTS.db),
    REDIS_PORT_HOST: String(SMOKE_PORTS.redis),
    PGBOUNCER_PORT_HOST: String(SMOKE_PORTS.pgbouncer),
    HTTP_PORT_HOST: String(SMOKE_PORTS.http),
    MAILPIT_UI_PORT_HOST: String(SMOKE_PORTS.mailpitUi),
    MAILPIT_SMTP_PORT_HOST: String(SMOKE_PORTS.mailpitSmtp),
    QUEUE_DASHBOARD_PORT_HOST: String(SMOKE_PORTS.dashboard),
    OTEL_PORT_HOST: String(SMOKE_PORTS.otel),
    SMOKE_SUBNET: subnet,
    // Compose trên Windows nhận `/`; `\` trong file dotenv là ký tự escape (review M9).
    APP_ENV_FILE: appFile.replaceAll('\\', '/'),
  };
  const render = (o: Record<string, string>) =>
    `${Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`;
  writeFileSync(appFile, render(app));
  writeFileSync(infraFile, render(infra));
  return {
    dir,
    infraFile,
    appFile,
    app,
    infra,
    requiredApp: appExample.required,
    requiredInfra: infraExample.required,
  };
}
