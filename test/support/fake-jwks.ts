import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from 'jose';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeJwks = {
  url: string;
  sign(
    claims: JWTPayload,
    opts?: {
      alg?: string;
      kid?: string;
      header?: Record<string, unknown>;
      foreign?: boolean;
    },
  ): Promise<string>;
  slow(ms: number): void;
  /** Trả status này (body không phải JWKS) thay vì 200 — mô phỏng IdP hỏng; `200` quay lại bình thường. */
  status(code: number): void;
  closedConnections(): number;
  close(): Promise<void>;
};
const ALG = 'RS256';
const KID = 'k1';
const OK = 200;

/**
 * JWKS giả trên loopback: ký token bằng khoá thật; `foreign` ký bằng khoá không có trong JWKS. `alg` khác RS256
 * ký bằng một khoá riêng của thuật toán đó (WebCrypto gắn thuật toán vào khoá), cũng không có trong JWKS.
 */
export async function startFakeJwks(): Promise<FakeJwks> {
  const own = await generateKeyPair(ALG);
  const foreign = await generateKeyPair(ALG);
  const pub: JWK = {
    ...(await exportJWK(own.publicKey)),
    kid: KID,
    alg: ALG,
    use: 'sig',
  };
  const otherAlgKeys = new Map<string, CryptoKey>();
  const keyFor = async (
    alg: string,
    useForeign: boolean,
  ): Promise<CryptoKey> => {
    if (alg === ALG) return (useForeign ? foreign : own).privateKey;
    const cached = otherAlgKeys.get(alg);
    if (cached) return cached;
    const { privateKey } = await generateKeyPair(alg);
    otherAlgKeys.set(alg, privateKey);
    return privateKey;
  };
  let delay = 0;
  let closed = 0;
  let code = OK;
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((_req, res) => {
    res.on('close', () => {
      closed++;
    });
    const send = () => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(code === OK ? JSON.stringify({ keys: [pub] }) : '{}');
    };
    if (delay > 0) {
      const t = setTimeout(() => {
        timers.delete(t);
        send();
      }, delay);
      timers.add(t);
    } else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
  return {
    url,
    sign: async (claims, o = {}) => {
      const alg = o.alg ?? ALG;
      return new SignJWT(claims)
        .setProtectedHeader({ alg, kid: o.kid ?? KID, ...o.header })
        .sign(await keyFor(alg, o.foreign === true));
    },
    slow: (ms) => {
      delay = ms;
    },
    status: (c) => {
      code = c;
    },
    closedConnections: () => closed,
    close: () =>
      new Promise<void>((r) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
