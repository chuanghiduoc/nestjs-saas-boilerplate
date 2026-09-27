import type { CredentialKind } from '../../../core/context/index.js';
import {
  effectiveCookiePrefix,
  type AuthMode,
  type IdentityConfig,
} from '../identity.config.js';

export type DetectedCredential = {
  kind: CredentialKind;
  value: string;
  cookieName?: string;
};
export type DetectionConfig = {
  mode: AuthMode;
  cookiePrefix: string;
  apiKeyHeader: string;
  externalTokenCookie?: string;
};
export type Detection =
  | { ok: true; credentials: DetectedCredential[]; hasAuthCookie: boolean }
  | { ok: false; reason: string };

const SECURE_PREFIX = '__Secure-';
const BEARER = /^Bearer ([^\s]+)$/;
export const sessionCookieNames = (prefix: string): [string, string] => [
  `${prefix}.session_token`,
  `${SECURE_PREFIX}${prefix}.session_token`,
];
export const twoFactorCookieNames = (prefix: string): [string, string] => [
  `${prefix}.two_factor`,
  `${SECURE_PREFIX}${prefix}.two_factor`,
];
export const detectionConfigOf = (
  id: IdentityConfig,
  app: { serviceName: string },
): DetectionConfig => ({
  mode: id.mode,
  cookiePrefix: effectiveCookiePrefix(id, app),
  apiKeyHeader: id.apiKeyHeader,
  externalTokenCookie: id.externalTokenCookie,
});

type Cookie = { name: string; value: string };
type Headers = {
  authz: string[];
  apiKeys: string[];
  cookieHeaders: Cookie[][];
};
const parseCookieHeader = (value: string): Cookie[] =>
  value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      return separator < 0
        ? { name: part, value: '' }
        : {
            name: part.slice(0, separator).trim(),
            value: part.slice(separator + 1).trim(),
          };
    });

function readHeaders(
  rawHeaders: readonly string[],
  cfg: DetectionConfig,
): Headers | undefined {
  const headers: Headers = { authz: [], apiKeys: [], cookieHeaders: [] };
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]?.toLowerCase();
    const value = rawHeaders[i + 1];
    if (name === undefined || value === undefined) return undefined;
    if (name === 'authorization') headers.authz.push(value);
    else if (name === cfg.apiKeyHeader) headers.apiKeys.push(value);
    else if (name === 'cookie')
      headers.cookieHeaders.push(parseCookieHeader(value));
  }
  return headers;
}

function duplicateReason(
  headers: Headers,
  cfg: DetectionConfig,
): string | undefined {
  const { authz, apiKeys, cookieHeaders } = headers;
  const [session, secureSession] = sessionCookieNames(cfg.cookiePrefix);
  const counted = new Set(
    cfg.mode === 'external'
      ? cfg.externalTokenCookie
        ? [cfg.externalTokenCookie]
        : []
      : [session, secureSession, ...twoFactorCookieNames(cfg.cookiePrefix)],
  );
  if (authz.length > 1) return 'multiple Authorization headers';
  if (apiKeys.length > 1 || apiKeys.some((key) => key.includes(',')))
    return 'multiple API keys';
  if (
    cookieHeaders.filter((cookies) =>
      cookies.some((cookie) => counted.has(cookie.name)),
    ).length > 1
  )
    return 'multiple Cookie headers with credentials';
  const seen = new Set<string>();
  for (const cookie of cookieHeaders.flat()) {
    if (!counted.has(cookie.name)) continue;
    if (seen.has(cookie.name)) return 'duplicate credential cookie';
    seen.add(cookie.name);
  }
  if (seen.has(session) && seen.has(secureSession))
    return 'both __Secure- and plain session cookies';
  return undefined;
}

function cookieCredential(
  cookies: readonly Cookie[],
  cfg: DetectionConfig,
): DetectedCredential | undefined {
  const names =
    cfg.mode === 'external'
      ? [cfg.externalTokenCookie]
      : sessionCookieNames(cfg.cookiePrefix);
  const cookie = cookies.find((candidate) => names.includes(candidate.name));
  if (!cookie) return undefined;
  return {
    kind: cfg.mode === 'external' ? 'EXTERNAL_COOKIE' : 'SESSION_COOKIE',
    value: cookie.value,
    cookieName: cookie.name,
  };
}

function hasAuthCookie(
  cookies: readonly Cookie[],
  cfg: DetectionConfig,
): boolean {
  if (cfg.mode === 'external')
    return cookies.some((cookie) => cookie.name === cfg.externalTokenCookie);
  const prefixes = [
    `${cfg.cookiePrefix}.`,
    `${SECURE_PREFIX}${cfg.cookiePrefix}.`,
  ];
  return cookies.some((cookie) =>
    prefixes.some((prefix) => cookie.name.startsWith(prefix)),
  );
}

/** Inspect raw headers before Node discards duplicates or Better Auth chooses a credential. */
export function detectCredentials(
  rawHeaders: readonly string[],
  cfg: DetectionConfig,
  opts: { allowCookieWithBearer?: boolean } = {},
): Detection {
  const headers = readHeaders(rawHeaders, cfg);
  if (!headers) return { ok: false, reason: 'malformed raw headers' };
  const reason = duplicateReason(headers, cfg);
  if (reason) return { ok: false, reason };
  const cookies = headers.cookieHeaders.flat();
  const credentials: DetectedCredential[] = [];
  const cookie = cookieCredential(cookies, cfg);
  if (cookie) credentials.push(cookie);
  const bearerHeader = headers.authz[0];
  if (bearerHeader !== undefined) {
    const token = BEARER.exec(bearerHeader)?.[1];
    if (!token)
      return { ok: false, reason: 'Authorization must be "Bearer <token>"' };
    credentials.push({
      kind: cfg.mode === 'external' ? 'EXTERNAL_BEARER' : 'BEARER_SESSION',
      value: token,
    });
  }
  const apiKey = headers.apiKeys[0];
  if (apiKey !== undefined)
    credentials.push({ kind: 'API_KEY', value: apiKey.trim() });
  const cookieWithBearer =
    credentials.length === 2 &&
    credentials[0]?.kind === 'SESSION_COOKIE' &&
    credentials[1]?.kind === 'BEARER_SESSION';
  if (
    credentials.length > 1 &&
    !(opts.allowCookieWithBearer && cookieWithBearer)
  )
    return { ok: false, reason: 'more than one credential' };
  return { ok: true, credentials, hasAuthCookie: hasAuthCookie(cookies, cfg) };
}
