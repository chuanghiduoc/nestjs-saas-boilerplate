import { randomBytes } from 'node:crypto';
import type { AppRole, SecretField } from '../../src/core/config/index.js';
import { smokeAppEnv } from '../smoke/smoke-app-env.js';
import { APP_EXAMPLE, readEnvExample } from '../smoke/smoke-env.js';

export type AuthModeCell = 'local' | 'hybrid' | 'external';
export type NodeEnvCell = 'development' | 'production';
export type RoleCell = {
  role: Exclude<AppRole, 'migrate'>;
  nodeEnv: NodeEnvCell;
  mode: AuthModeCell;
  smtpAuth: boolean;
  google: boolean;
};

/** Giá trị test của MỌI secret boilerplate. Secret mới mà thiếu dòng ở đây làm ma trận đỏ có tên (không lọt). */
export const SECRET_TEST_VALUES: Readonly<Record<string, string>> = {
  AUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
  AUTH_OIDC_CLIENT_SECRET: 'oidc-client-secret',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  DB_APP_PASSWORD: 'app-password',
  DB_AUTH_PASSWORD: 'auth-password',
  DB_OWNER_PASSWORD: 'owner-password',
  DB_RELAY_PASSWORD: 'relay-password',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({
    s1: randomBytes(32).toString('base64'),
  }),
  REDIS_URL: 'rediss://app:redis-password@redis:6379',
  SMTP_PASSWORD: 'smtp-password',
};
const HYBRID_PUBLIC = {
  AUTH_MODE: 'hybrid',
  AUTH_OIDC_PROVIDER_ID: 'corp',
  AUTH_OIDC_DISCOVERY_URL:
    'https://idp.example.test/.well-known/openid-configuration',
  AUTH_OIDC_CLIENT_ID: 'corp-client',
};
const EXTERNAL_PUBLIC = {
  AUTH_MODE: 'external',
  AUTH_EXTERNAL_JWKS_URL: 'https://idp.example.test/jwks',
  AUTH_EXTERNAL_ISSUER: 'https://idp.example.test',
  AUTH_EXTERNAL_AUDIENCE: 'api',
  AUTH_EXTERNAL_ALGORITHMS: 'RS256',
  AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
  AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
};

/**
 * Config KHÔNG bí mật hợp lệ cho production, giống smoke (image thật chạy xanh với nó): giá trị mặc định của
 * `.env.example` + ghi đè của smoke, bỏ mọi tên secret (secret chỉ tới theo vai trò, `cellEnv`).
 */
export function nonSecretBase(
  nodeEnv: NodeEnvCell,
  secretNames: ReadonlySet<string>,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...readEnvExample(APP_EXAMPLE).values,
    ...smokeAppEnv({ secret: () => 'unused' }),
    NODE_ENV: nodeEnv,
    DB_HOST: 'pgbouncer',
    DB_NAME: 'app',
    DB_SSL_MODE: 'verify-full',
    DB_SSL_CA_PATH: '/certs/ca.crt',
    FIELD_ENCRYPTION_ACTIVE_KID: 's1',
    SMTP_HOST: 'mail.example.test',
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([k]) => !secretNames.has(k)),
  );
}

/** Secret bật theo tính năng: vận hành không khai secret của tính năng đang tắt. */
const featureOff = (cell: RoleCell): Set<string> =>
  new Set([
    ...(cell.smtpAuth ? [] : ['SMTP_PASSWORD']),
    ...(cell.google ? [] : ['AUTH_GOOGLE_CLIENT_SECRET']),
    ...(cell.mode === 'hybrid' ? [] : ['AUTH_OIDC_CLIENT_SECRET']),
  ]);

/** Env của một ô: config không bí mật + CHỈ secret mà metadata cho vai trò đó (trừ secret của tính năng đang tắt). */
export function cellEnv(
  cell: RoleCell,
  fields: readonly SecretField[],
): Record<string, string> {
  const names = new Set(fields.map((f) => f.env));
  const env: Record<string, string> = {
    ...nonSecretBase(cell.nodeEnv, names),
    APP_ROLE: cell.role,
    ...(cell.mode === 'hybrid' ? HYBRID_PUBLIC : {}),
    ...(cell.mode === 'external' ? EXTERNAL_PUBLIC : {}),
    ...(cell.smtpAuth ? { SMTP_USER: 'mailer' } : {}),
    ...(cell.google ? { AUTH_GOOGLE_CLIENT_ID: 'google-client-id' } : {}),
  };
  const off = featureOff(cell);
  for (const f of fields) {
    if (!f.roles.includes(cell.role) || off.has(f.env)) continue;
    const value = SECRET_TEST_VALUES[f.env];
    if (value === undefined)
      throw new Error(
        `${f.env} is a secret without a test value; add it to SECRET_TEST_VALUES`,
      );
    env[f.env] = value;
  }
  return env;
}

/** Secret mà một luật đòi ở ô này: bỏ một cái thì validate phải đỏ với đúng tên env. */
export function requiredSecretsOf(cell: RoleCell): string[] {
  const common = ['DB_APP_PASSWORD', 'FIELD_ENCRYPTION_KEYS', 'REDIS_URL'];
  const betterAuth =
    cell.mode === 'external' ? [] : ['BETTER_AUTH_SECRET', 'DB_AUTH_PASSWORD'];
  switch (cell.role) {
    case 'api':
      return [
        ...common,
        ...betterAuth,
        ...(cell.google ? ['AUTH_GOOGLE_CLIENT_SECRET'] : []),
        ...(cell.mode === 'hybrid' ? ['AUTH_OIDC_CLIENT_SECRET'] : []),
      ];
    case 'worker':
      return [
        ...common,
        ...betterAuth,
        ...(cell.smtpAuth ? ['SMTP_PASSWORD'] : []),
      ];
    default: {
      const unknown: never = cell.role;
      throw new Error(`Unknown role ${String(unknown)}`);
    }
  }
}

export const ROLE_CELLS: readonly RoleCell[] = (
  ['api', 'worker'] as const
).flatMap((role) =>
  (['development', 'production'] as const).flatMap((nodeEnv) =>
    (['local', 'hybrid', 'external'] as const).flatMap((mode) =>
      [false, true].flatMap((smtpAuth) =>
        [false, true].map((google) => ({
          role,
          nodeEnv,
          mode,
          smtpAuth,
          google,
        })),
      ),
    ),
  ),
);
