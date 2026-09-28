import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SignJWT,
  UnsecuredJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';

export const FAKE_IDP_CLIENT_ID = 'client';
export const FAKE_IDP_CLIENT_SECRET = 'secret';
const ID_TOKEN_ALG = 'RS256';
const TOKEN_TTL_SEC = 3600;
const CODE_BYTES = 24;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const BASIC_PREFIX = 'Basic ';
const BEARER_PREFIX = 'Bearer ';

/**
 * Cách IdP phát `id_token` ở `/token` (S2-R37):
 * - `signed`: ký bằng khoá hiện hành, có trong JWKS, nonce đúng của lần authorize;
 * - `foreign-key`: chữ ký hợp lệ về mặt mật mã nhưng bằng khoá KHÔNG có trong JWKS (sai chữ ký với IdP);
 * - `unsigned`: `alg: none` (JWT không ký);
 * - `wrong-nonce`: ký đúng khoá nhưng nonce của một lần authorize khác (token bị phát lại).
 */
export type IdTokenMode = 'signed' | 'foreign-key' | 'unsigned' | 'wrong-nonce';

export type FakeIdp = {
  url: string;
  discoveryUrl: string;
  /** Claim của các lần authorize SAU lời gọi này (chụp lại ở `/authorize`, nên luồng song song không giẫm nhau). */
  setClaims(c: Record<string, unknown>): void;
  setIdTokenMode(mode: IdTokenMode): void;
  /** `false`: discovery không có `jwks_uri` (provider phải bị từ chối lúc boot, S2-R37). */
  setPublishJwks(on: boolean): void;
  /** Khoá ký mới thành khoá hiện hành; khoá cũ vẫn được công bố trong JWKS (xoay có chồng lấn). */
  rotateKeys(): Promise<void>;
  /** `kid` của khoá ký hiện hành. */
  currentKid(): string;
  /** Token cuối cùng `/token` đã phát (để kiểm bản rõ không nằm trong DB). */
  lastIssued():
    { accessToken: string; idToken: string | undefined } | undefined;
  /**
   * Trình duyệt mở URL authorize mà app trả về: IdP kiểm request, cấp code và trả 302 về `redirect_uri` của app.
   * Trả URL callback (có `code`, `state`, `iss`).
   */
  authorize(authorizationUrl: string): Promise<URL>;
  close(): Promise<void>;
};

type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: JWK };
type Grant = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | undefined;
  claims: Record<string, unknown>;
};

async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ID_TOKEN_ALG);
  const kid = randomUUID();
  return {
    kid,
    privateKey,
    publicJwk: {
      ...(await exportJWK(publicKey)),
      kid,
      alg: ID_TOKEN_ALG,
      use: 'sig',
    },
  };
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
};
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
};
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/** Client xác thực ở `/token` bằng `client_secret_basic` hoặc `client_secret_post` (RFC 6749 §2.3.1). */
function clientAuthenticated(
  req: IncomingMessage,
  form: URLSearchParams,
): string | undefined {
  const header = req.headers.authorization;
  let id = form.get('client_id') ?? undefined;
  let secret = form.get('client_secret') ?? undefined;
  if (header?.startsWith(BASIC_PREFIX)) {
    const decoded = Buffer.from(
      header.slice(BASIC_PREFIX.length),
      'base64',
    ).toString('utf8');
    const sep = decoded.indexOf(':');
    id = decodeURIComponent(decoded.slice(0, sep));
    secret = decodeURIComponent(decoded.slice(sep + 1));
  }
  return id === FAKE_IDP_CLIENT_ID && secret === FAKE_IDP_CLIENT_SECRET
    ? id
    : undefined;
}

/**
 * IdP OIDC thật (nhưng tối giản) cho `genericOAuth` của Better Auth 1.7.6: discovery, `/authorize` (code + PKCE S256
 * + nonce), `/token` (xác thực client, code dùng một lần, kiểm `redirect_uri` và PKCE, `id_token` RS256 ký bằng
 * `jose`), `/userinfo`, `/jwks` với khoá xoay được. Chỉ lắng nghe 127.0.0.1, cổng ngẫu nhiên.
 */
export async function startFakeIdp(options: {
  redirectUri: string;
}): Promise<FakeIdp> {
  let base = '';
  let claims: Record<string, unknown> = {};
  let mode: IdTokenMode = 'signed';
  let publishJwks = true;
  let current = await newSigningKey();
  const published: SigningKey[] = [current];
  const foreign = await newSigningKey();
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Record<string, unknown>>();
  let issued: { accessToken: string; idToken: string | undefined } | undefined;

  const idToken = async (grant: Grant): Promise<string | undefined> => {
    const payload = {
      ...grant.claims,
      ...(grant.nonce === undefined ? {} : { nonce: grant.nonce }),
    };
    const sign = (key: SigningKey, p: Record<string, unknown>) =>
      new SignJWT(p)
        .setProtectedHeader({ alg: ID_TOKEN_ALG, kid: key.kid, typ: 'JWT' })
        .setIssuer(base)
        .setAudience(grant.clientId)
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_TTL_SEC}s`)
        .sign(key.privateKey);
    switch (mode) {
      case 'signed':
        return sign(current, payload);
      case 'foreign-key':
        return sign(foreign, payload);
      case 'unsigned':
        return new UnsecuredJWT(payload)
          .setIssuer(base)
          .setAudience(grant.clientId)
          .setIssuedAt()
          .setExpirationTime(`${TOKEN_TTL_SEC}s`)
          .encode();
      case 'wrong-nonce':
        return sign(current, { ...payload, nonce: `replayed-${randomUUID()}` });
      default: {
        const unknown: never = mode;
        throw new Error(`unknown id_token mode ${String(unknown)}`);
      }
    }
  };

  const authorizeEndpoint = (url: URL, res: ServerResponse): void => {
    const q = url.searchParams;
    const clientId = q.get('client_id');
    const redirectUri = q.get('redirect_uri');
    const state = q.get('state');
    const codeChallenge = q.get('code_challenge');
    if (
      q.get('response_type') !== 'code' ||
      clientId !== FAKE_IDP_CLIENT_ID ||
      !redirectUri ||
      redirectUri !== options.redirectUri ||
      !q.get('scope')?.split(/\s+/).includes('openid') ||
      !state ||
      !codeChallenge ||
      q.get('code_challenge_method') !== 'S256'
    )
      return json(res, HTTP_BAD_REQUEST, { error: 'invalid_request' });
    const code = randomBytes(CODE_BYTES).toString('base64url');
    const nonce = q.get('nonce') ?? undefined;
    grants.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      nonce,
      claims: { ...claims },
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    back.searchParams.set('iss', base);
    res.statusCode = HTTP_FOUND;
    res.setHeader('location', back.toString());
    res.end();
  };

  const tokenEndpoint = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const form = new URLSearchParams(await readBody(req));
    const clientId = clientAuthenticated(req, form);
    if (!clientId)
      return json(res, HTTP_UNAUTHORIZED, { error: 'invalid_client' });
    const code = form.get('code') ?? '';
    const grant = grants.get(code);
    grants.delete(code);
    const verifier = form.get('code_verifier');
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !grant ||
      grant.clientId !== clientId ||
      grant.redirectUri !== form.get('redirect_uri') ||
      !verifier ||
      s256(verifier) !== grant.codeChallenge
    )
      return json(res, HTTP_BAD_REQUEST, { error: 'invalid_grant' });
    const accessToken = `at-${randomBytes(CODE_BYTES).toString('base64url')}`;
    accessTokens.set(accessToken, grant.claims);
    const token = await idToken(grant);
    issued = { accessToken, idToken: token };
    json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SEC,
      scope: 'openid email profile',
      ...(token === undefined ? {} : { id_token: token }),
    });
  };

  const userinfoEndpoint = (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization ?? '';
    const c = auth.startsWith(BEARER_PREFIX)
      ? accessTokens.get(auth.slice(BEARER_PREFIX.length))
      : undefined;
    if (!c) return json(res, HTTP_UNAUTHORIZED, { error: 'invalid_token' });
    json(res, 200, c);
  };

  const discovery = () => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    ...(publishJwks ? { jwks_uri: `${base}/jwks` } : {}),
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [ID_TOKEN_ALG],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    authorization_response_iss_parameter_supported: true,
  });

  const route = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', base);
    const method = req.method ?? 'GET';
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json(res, 200, discovery());
      case '/jwks':
        return publishJwks
          ? json(res, 200, { keys: published.map((k) => k.publicJwk) })
          : json(res, HTTP_NOT_FOUND, {});
      case '/authorize':
        return authorizeEndpoint(url, res);
      case '/token':
        return method === 'POST'
          ? tokenEndpoint(req, res)
          : json(res, HTTP_METHOD_NOT_ALLOWED, {});
      case '/userinfo':
        return userinfoEndpoint(req, res);
      default:
        return json(res, HTTP_NOT_FOUND, {});
    }
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'fake idp error');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fake IdP did not bind a TCP port');
  base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
    setClaims: (c) => {
      claims = c;
    },
    setIdTokenMode: (m) => {
      mode = m;
    },
    setPublishJwks: (on) => {
      publishJwks = on;
    },
    rotateKeys: async () => {
      current = await newSigningKey();
      published.push(current);
    },
    currentKid: () => current.kid,
    lastIssued: () => issued,
    authorize: async (authorizationUrl) => {
      const res = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== HTTP_FOUND || !location)
        throw new Error(`fake IdP authorize failed: ${res.status}`);
      return new URL(location);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Better Auth (undici) giữ connection keep-alive tới IdP: đóng hết, không thì `close` chờ tới khi chúng hết hạn.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
