import type { INestApplication } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { v7 } from 'uuid';
import type { Mailpit } from './mailpit.js';
import { authed } from './tenancy-app.js';
import type { SeededPrincipal } from './tenancy-principals.js';

/** Token 32 byte base64url ở fragment của link trong thư (spec §9.1). Không bao giờ log nó. */
const TOKEN_FRAGMENT = /#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;
/** IP riêng mỗi lần preview (dải benchmark RFC 2544, như `AuthClient`): bucket `tenancy.token-preview` khoá theo IP. */
export const previewIp = (): string =>
  `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;

export async function tokenFromMail(
  mail: Mailpit,
  to: string,
  subject: RegExp,
  after: number,
): Promise<string> {
  const msg = await mail.waitFor(to, { subject, after });
  const token = TOKEN_FRAGMENT.exec(msg.Text)?.[1];
  if (!token) throw new Error('no #token= fragment in the email');
  return token;
}
export const acceptInvitation = (
  app: INestApplication,
  p: SeededPrincipal,
  body: unknown,
) =>
  authed(app, p)
    .post('/v1/invitations/accept')
    .set('idempotency-key', `k-${v7()}`)
    .send(body as object);
export const joinInviteLink = (
  app: INestApplication,
  p: SeededPrincipal,
  body: unknown,
) =>
  authed(app, p)
    .post('/v1/invite-links/join')
    .set('idempotency-key', `k-${v7()}`)
    .send(body as object);
/** Route public: không credential; IP qua `x-forwarded-for` (app test chạy với `HTTP_TRUST_PROXY=loopback`). */
export const previewToken = (
  app: INestApplication,
  kind: 'invitations' | 'invite-links',
  body: unknown,
  ip = previewIp(),
) =>
  request(app.getHttpServer())
    .post(`/v1/${kind}/preview`)
    .set('x-forwarded-for', ip)
    .send(body as object);
/** Phần của problem+json phải giống hệt giữa các đường lỗi (bỏ `instance`, `requestId`, `timestamp`; spec §18.2). */
export const problemCore = (b: Record<string, unknown>) => ({
  type: b['type'],
  title: b['title'],
  status: b['status'],
  code: b['code'],
  detail: b['detail'],
});
