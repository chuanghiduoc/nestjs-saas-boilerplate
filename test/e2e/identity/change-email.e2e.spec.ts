import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import type { MailpitMessage } from '../../support/mailpit.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const PASSWORD = 'correct horse battery';
const CONFIRM_SUBJECT = /Confirm your account email change/;
const VERIFY_SUBJECT = /Verify your email/;
const EXISTS_SUBJECT = /You already have an account/;
/** Đủ lâu để outbox relay + worker gửi thư nếu có thư; dùng cho khẳng định "KHÔNG có thư". */
const NO_MAIL_WAIT_MS = 3000;
const mail = mailpitFromInfra();

/** Link `/api/auth/verify-email?...` trong phần text của thư (host là AUTH_BASE_URL). */
const verifyLink = (msg: MailpitMessage): string => {
  const link = /https?:\/\/[^\s"<>]+\/api\/auth\/verify-email\?[^\s"<>]+/.exec(
    msg.Text,
  )?.[0];
  if (!link) throw new Error('no verify-email link in the email');
  const u = new URL(link.replaceAll('&amp;', '&'));
  return `${u.pathname}${u.search}`;
};
const userRow = async (id: string) =>
  ownerQuery<{ email: string; email_verified: boolean }>(
    `SELECT email, email_verified FROM auth."user" WHERE id = $1`,
    [id],
  );
const noMailTo = async (to: string, subject: RegExp, after: number) => {
  await new Promise((r) => setTimeout(r, NO_MAIL_WAIT_MS));
  const hits = (await mail.messages(to)).filter(
    (m) => subject.test(m.Subject) && Date.parse(m.Created) >= after,
  );
  expect(hits).toEqual([]);
};

/**
 * S2-R42 phần B: đổi email hai bước của Better Auth (`user.changeEmail.sendChangeEmailConfirmation`) qua HTTP thật +
 * outbox + worker + Mailpit. Địa chỉ CŨ xác nhận trước, rồi địa chỉ MỚI xác thực, rồi email mới đổi.
 */
describe('change email: old address confirms first, then the new address verifies (S2-R42)', () => {
  let app: INestApplication;
  const client = () => new AuthClient(app.getHttpServer());
  /** User đã xác thực + đăng nhập (session mới). */
  const registered = async () => {
    const email = `ce-${v7()}@example.test`;
    const c = client();
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    expect((await c.verifyEmailFromMailpit(mail, email)).status).toBeLessThan(
      400,
    );
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    const [row] = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = $1`,
      [email],
    );
    if (!row) throw new Error('user row not found');
    return { email, id: row.id, c };
  };
  const changeEmail = (c: AuthClient, newEmail: string) =>
    c.request('post', '/api/auth/change-email', { body: { newEmail } });

  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => app?.close());

  it('request → confirmation to the OLD address only → click → verification to the NEW address → click → email changed', async () => {
    const { email, id, c } = await registered();
    const newEmail = `ce-new-${v7()}@example.test`;
    const started = Date.now();
    const res = await changeEmail(c, newEmail);
    expect(res.status).toBe(202);

    // 1. Thư xác nhận tới địa chỉ CŨ; địa chỉ MỚI chưa nhận gì, email chưa đổi.
    const confirm = await mail.waitFor(email, {
      subject: CONFIRM_SUBJECT,
      after: started,
    });
    expect(confirm.To.map((a) => a.Address)).toEqual([email]);
    // Thư xác nhận không lộ địa chỉ mới (params chỉ có tên + link, spec §5.16c).
    expect(`${confirm.Text}${confirm.HTML}`).not.toContain(newEmail);
    expect(await mail.messages(newEmail)).toEqual([]);
    expect(await userRow(id)).toEqual([{ email, email_verified: true }]);

    // 2. Bấm link xác nhận (không cookie, như mở từ hộp thư) → thư xác thực tới địa chỉ MỚI; email vẫn chưa đổi.
    const clickedConfirm = Date.now();
    const confirmed = await client().request('get', verifyLink(confirm), {
      cookie: false,
    });
    expect(confirmed.status).toBeLessThan(400);
    const verify = await mail.waitFor(newEmail, {
      subject: VERIFY_SUBJECT,
      after: clickedConfirm,
    });
    expect(await userRow(id)).toEqual([{ email, email_verified: true }]);

    // 3. Bấm link xác thực ở địa chỉ mới → email đổi, vẫn đã xác thực; đăng nhập bằng email mới.
    const verified = await client().request('get', verifyLink(verify), {
      cookie: false,
    });
    expect(verified.status).toBeLessThan(400);
    expect(await userRow(id)).toEqual([
      { email: newEmail, email_verified: true },
    ]);
    expect((await client().signIn(newEmail, PASSWORD)).status).toBe(200);
    expect((await client().signIn(email, PASSWORD)).status).toBe(401);
  });

  it('a stale session gets 403 reauthentication_required and no email is sent (Task 34 fresh-session rule)', async () => {
    const { email, id, c } = await registered();
    await ownerQuery(
      `UPDATE auth.session SET created_at = now() - interval '1 day' WHERE user_id = $1`,
      [id],
    );
    const started = Date.now();
    const newEmail = `ce-stale-${v7()}@example.test`;
    const res = await changeEmail(c, newEmail);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauthentication_required');
    await noMailTo(email, CONFIRM_SUBJECT, started);
    expect(await mail.messages(newEmail)).toEqual([]);
    expect(await userRow(id)).toEqual([{ email, email_verified: true }]);
  });

  it('a taken new address answers the same 202 (S2-R58 floor) and only notifies the owner of that address', async () => {
    const taken = await registered();
    const me = await registered();
    const shape = (r: { status: number; text: string; headers: object }) => ({
      status: r.status,
      body: r.text,
      headers: Object.keys(r.headers)
        .filter((h) => !['date', 'x-request-id'].includes(h))
        .sort((a, b) => a.localeCompare(b)),
    });
    const started = Date.now();
    const free = shape(await changeEmail(me.c, `ce-free-${v7()}@example.test`));
    const takenRes = shape(await changeEmail(me.c, taken.email));
    expect(free.status).toBe(202);
    expect(takenRes).toEqual(free);
    // Chủ địa chỉ đích nhận thông báo "đã có tài khoản" (spec §5.8); email của không ai bị đổi.
    await mail.waitFor(taken.email, {
      subject: EXISTS_SUBJECT,
      after: started,
    });
    expect(await userRow(me.id)).toEqual([
      { email: me.email, email_verified: true },
    ]);
    expect(await userRow(taken.id)).toEqual([
      { email: taken.email, email_verified: true },
    ]);
  });

  it('S2-R40: when an UNVERIFIED account verifies its new address, unproven IdP links and all sessions are reclaimed', async () => {
    const { email, id, c } = await registered();
    // Mô phỏng user được tạo qua một IdP không tin cậy (spec §5.4): chưa xác thực, có liên kết IdP và một session khác.
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = false WHERE id = $1`,
      [id],
    );
    await ownerQuery(
      `INSERT INTO auth.account (account_id, provider_id, user_id, created_at, updated_at)
       VALUES ($1, 'untrusted-idp', $2, now(), now())`,
      [v7(), id],
    );
    const sessionsBefore = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth.session WHERE user_id = $1`,
      [id],
    );
    expect(sessionsBefore.length).toBeGreaterThan(0);
    const newEmail = `ce-reclaim-${v7()}@example.test`;
    const started = Date.now();
    // User chưa xác thực: Better Auth bỏ bước xác nhận ở địa chỉ cũ, gửi thẳng thư xác thực tới địa chỉ mới.
    expect((await changeEmail(c, newEmail)).status).toBe(202);
    const verify = await mail.waitFor(newEmail, {
      subject: VERIFY_SUBJECT,
      after: started,
    });
    await noMailTo(email, CONFIRM_SUBJECT, started);
    const verified = await client().request('get', verifyLink(verify), {
      cookie: false,
    });
    expect(verified.status).toBeLessThan(400);
    expect(await userRow(id)).toEqual([
      { email: newEmail, email_verified: true },
    ]);
    expect(
      await ownerQuery(
        `SELECT provider_id FROM auth.account WHERE user_id = $1 ORDER BY provider_id`,
        [id],
      ),
    ).toEqual([{ provider_id: 'credential' }]);
    const survivors = await ownerQuery<{ id: string }>(
      `SELECT id FROM auth.session WHERE user_id = $1 AND id = ANY($2)`,
      [id, sessionsBefore.map((s) => s.id)],
    );
    expect(survivors).toEqual([]);
    expect((await c.request('get', '/v1/me')).status).toBe(401);
  });
});
