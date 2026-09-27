import type { IncomingMessage } from 'node:http';
import type { CredentialKind } from '../../../core/context/index.js';

/**
 * RFC 7231 §4.2.1: only these are safe. HTTP methods are open-ended (WebDAV verbs like `PROPFIND`,
 * custom verbs), so an allow-list of safe methods is the only sound way to decide "unsafe" — a
 * deny-list of known-unsafe methods lets an unlisted verb through unchecked.
 */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Node folds a repeated header into an array; the CSRF check only ever cares about the first
 * occurrence of `origin`/`sec-fetch-site` (Task 45 review M2: was duplicated in `principal.middleware.ts`
 * and `platform-admin.authorizer.ts`).
 */
export function singleHeader(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
const SAME_ORIGIN = 'same-origin';
// Origin is a serialized HTTP(S) origin, not a URL with credentials or a path.
const ORIGIN_PATTERN = /^https?:\/\/[^\s/\\?#@]+$/i;

function normalizedOrigin(value: string): string | undefined {
  if (!ORIGIN_PATTERN.test(value) || !URL.canParse(value)) return undefined;
  return new URL(value).origin;
}

/** Shared with Better Auth: normalized CORS origins plus AUTH_BASE_URL's origin. */
export function trustedOriginList(
  corsOrigins: readonly string[],
  baseUrl: string | undefined,
): string[] {
  const origins = corsOrigins.map((value) => {
    const origin = normalizedOrigin(value);
    if (!origin) throw new Error('Invalid trusted CORS origin');
    return origin;
  });
  if (baseUrl !== undefined) {
    if (!URL.canParse(baseUrl))
      throw new Error('Invalid authentication base URL');
    const origin = normalizedOrigin(new URL(baseUrl).origin);
    if (!origin) throw new Error('Invalid authentication base URL origin');
    origins.push(origin);
  }
  return [...new Set(origins)];
}

export const isCookieCredential = (kind: CredentialKind): boolean =>
  kind === 'SESSION_COOKIE' || kind === 'EXTERNAL_COOKIE';

/** Caller selects cookie-authenticated requests; a present invalid Origin never falls back. */
export function csrfAllows(
  input: { method: string; origin?: string; secFetchSite?: string },
  trusted: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;
  if (input.origin === undefined) return input.secFetchSite === SAME_ORIGIN;
  const origin = normalizedOrigin(input.origin);
  return origin !== undefined && trusted.has(origin);
}
