import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from 'jose';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
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
  /**
   * Ký bằng khoá RSA 1024 bit mà JWKS cũng công bố (kid `weak`): IdP phát khoá jose không chấp nhận, jose ném
   * `TypeError` (không phải `JOSEError`) — lỗi ngoài phân loại, phải thành 500 chứ không 503 (S2-R55).
   */
  signWithWeakKey(claims: JWTPayload): string;
  slow(ms: number): void;
  /** Trả status này (body không phải JWKS) thay vì 200 — mô phỏng IdP hỏng; `200` quay lại bình thường. */
  status(code: number): void;
  /** Số request JWKS đã nhận. */
  requests(): number;
  /** Số response bị client huỷ trước khi gửi xong (không tính response hoàn tất bình thường). */
  abortedConnections(): number;
  close(): Promise<void>;
};
const ALG = 'RS256';
const KID = 'k1';
const WEAK_KID = 'weak';
const WEAK_MODULUS_BITS = 1024;
const OK = 200;
const b64url = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

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
  const weak = generateKeyPairSync('rsa', {
    modulusLength: WEAK_MODULUS_BITS,
  });
  const weakPub: JWK = {
    ...weak.publicKey.export({ format: 'jwk' }),
    kid: WEAK_KID,
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
  let aborted = 0;
  let received = 0;
  let code = OK;
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((_req, res) => {
    received++;
    res.on('close', () => {
      if (!res.writableFinished) aborted++;
    });
    const send = () => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(code === OK ? JSON.stringify({ keys: [pub, weakPub] }) : '{}');
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
    signWithWeakKey: (claims) => {
      const input = `${b64url({ alg: ALG, kid: WEAK_KID })}.${b64url(claims)}`;
      const sig = nodeSign('sha256', Buffer.from(input), weak.privateKey);
      return `${input}.${sig.toString('base64url')}`;
    },
    slow: (ms) => {
      delay = ms;
    },
    status: (c) => {
      code = c;
    },
    requests: () => received,
    abortedConnections: () => aborted,
    close: () =>
      new Promise<void>((r) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
