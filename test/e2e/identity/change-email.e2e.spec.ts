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
/** Đủ lâu để outbox relay + worker gửi thư nếu có thư; dùng cho khẳng định "KHÔNG có thư" / "đúng N thư". */
const NO_MAIL_WAIT_MS = 3000;
const POLL_MS = 200;
const ANY = /./;
/** Mức sàn S2-R58 bật cho file này (bấm link xác nhận cũng phải được đệm, S2-R68 I2). */
const FLOOR_MS = 300;
/** Ngưỡng `/change-email` theo IP (S2-R68 I1); mỗi client của test là một IP. */
const EMAIL_RATE_MAX = 3;
/** Ngưỡng riêng của `/verify-email` (khác `EMAIL_RATE_MAX` để chứng minh hai luật độc lập). */
const VERIFY_EMAIL_RATE_MAX = EMAIL_RATE_MAX + 2;
/** Độ phân giải của `iat` trong JWT (giây) cộng biên. */
const JWT_IAT_RESOLUTION_MS = 1100;
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
/**
 * Hỏi Mailpit liên tục trong `NO_MAIL_WAIT_MS` (đủ cho relay + worker giao thư), dừng sớm nếu đã vượt `max` thư khớp;
 * trả về các thư khớp ở lần hỏi cuối. Dùng cho "không có thư" (max 0) và "đúng một thư" (max 1): thư tới muộn không lọt.
 * `after` so với `Created` (container Mailpit đóng dấu) nên LUÔN phải là kết quả của `mail.now()` (đồng hồ
 * container), KHÔNG BAO GIỜ `Date.now()` của host: đồng hồ VM container lệch sau đồng hồ host (Docker
 * Desktop/WSL2 sau sleep/resume) từng làm khẳng định "không có thư" pass giả dù thư đã gửi (M4). Vòng lặp bên
 * dưới CHỈ dùng `Date.now()` cho `deadline` cục bộ của chính vòng lặp — không so với `Created`, không lệ thuộc
 * đồng hồ container.
 */
const settledMail = async (
  to: string,
  subject: RegExp,
  after: number,
  max: number,
) => {
  const deadline = Date.now() + NO_MAIL_WAIT_MS;
  for (;;) {
    const hits = (await mail.messages(to)).filter(
      (m) => subject.test(m.Subject) && Date.parse(m.Created) >= after,
    );
    if (hits.length > max || Date.now() >= deadline) return hits;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};
const noMailTo = async (to: string, subject: RegExp, after: number) =>
  expect(await settledMail(to, subject, after, 0)).toEqual([]);

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
    app = await startIdentityApp({
      env: {
        AUTH_ENUMERATION_MIN_RESPONSE_MS: String(FLOOR_MS),
        AUTH_EMAIL_RATE_MAX: String(EMAIL_RATE_MAX),
        AUTH_VERIFY_EMAIL_RATE_MAX: String(VERIFY_EMAIL_RATE_MAX),
      },
    });
  });
  afterAll(async () => app?.close());

  it('request → confirmation to the OLD address only → click → verification to the NEW address → click → email changed', async () => {
    const { email, id, c } = await registered();
    const newEmail = `ce-new-${v7()}@example.test`;
    const started = await mail.now();
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
    await noMailTo(newEmail, ANY, started);
    expect(await userRow(id)).toEqual([{ email, email_verified: true }]);

    // 2. Bấm link xác nhận (không cookie, như mở từ hộp thư) → thư xác thực tới địa chỉ MỚI; email vẫn chưa đổi.
    const clickedConfirm = await mail.now();
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
    const started = await mail.now();
    const newEmail = `ce-stale-${v7()}@example.test`;
    const res = await changeEmail(c, newEmail);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauthentication_required');
    await noMailTo(email, CONFIRM_SUBJECT, started);
    await noMailTo(newEmail, ANY, started);
    expect(await userRow(id)).toEqual([{ email, email_verified: true }]);
  });

  it('S2-R66: free and taken targets look the same to the requester (202 + one confirmation each); the click then verifies a free target or only notifies the owner of a taken one', async () => {
    const taken = await registered();
    const meFree = await registered();
    const meTaken = await registered();
    const freeEmail = `ce-free-${v7()}@example.test`;
    const shape = (r: { status: number; text: string; headers: object }) => ({
      status: r.status,
      body: r.text,
      headers: Object.keys(r.headers)
        .filter((h) => !['date', 'x-request-id'].includes(h))
        .sort((a, b) => a.localeCompare(b)),
    });

    // 1. Yêu cầu: cùng 202 (sàn S2-R58) và MỖI người yêu cầu nhận đúng một thư xác nhận ở địa chỉ cũ của mình.
    const requested = await mail.now();
    const free = shape(await changeEmail(meFree.c, freeEmail));
    const takenRes = shape(await changeEmail(meTaken.c, taken.email));
    expect(free.status).toBe(202);
    expect(takenRes).toEqual(free);
    const confirmFree = await mail.waitFor(meFree.email, {
      subject: CONFIRM_SUBJECT,
      after: requested,
    });
    const confirmTaken = await mail.waitFor(meTaken.email, {
      subject: CONFIRM_SUBJECT,
      after: requested,
    });
    const confirmations = async (to: string) =>
      (await mail.messages(to)).filter(
        (m) =>
          CONFIRM_SUBJECT.test(m.Subject) && Date.parse(m.Created) >= requested,
      ).length;
    expect([
      await confirmations(meFree.email),
      await confirmations(meTaken.email),
    ]).toEqual([1, 1]);
    // Chưa ai bấm: chủ địa chỉ đích chưa nhận gì.
    await noMailTo(taken.email, EXISTS_SUBJECT, requested);

    // 2. Bấm link xác nhận: phản hồi giống hệt nhau.
    const clicked = await mail.now();
    const clickShape = (r: {
      status: number;
      text: string;
      headers: object;
    }) => ({
      ...shape(r),
      location: (r.headers as Record<string, string | undefined>).location,
    });
    const clickFree = clickShape(
      await client().request('get', verifyLink(confirmFree), { cookie: false }),
    );
    const clickTaken = clickShape(
      await client().request('get', verifyLink(confirmTaken), {
        cookie: false,
      }),
    );
    expect(clickFree.status).toBeLessThan(400);
    expect(clickTaken).toEqual(clickFree);

    // Đích trống → thư xác thực tới địa chỉ mới; đích đã có → CHỈ thông báo cho chủ của nó.
    await mail.waitFor(freeEmail, { subject: VERIFY_SUBJECT, after: clicked });
    await mail.waitFor(taken.email, {
      subject: EXISTS_SUBJECT,
      after: clicked,
    });
    await noMailTo(taken.email, VERIFY_SUBJECT, clicked);
    // Người yêu cầu không nhận thêm thư nào sau khi bấm (không có kênh dò qua hộp thư của mình).
    await noMailTo(meTaken.email, ANY, clicked);
    await noMailTo(meFree.email, ANY, clicked);
    for (const u of [taken, meFree, meTaken])
      expect(await userRow(u.id)).toEqual([
        { email: u.email, email_verified: true },
      ]);
  });

  it('S2-R68: the same confirmation link clicked 3 times sends exactly ONE email per branch; every click is padded to the floor and answers the same', async () => {
    const taken = await registered();
    const meFree = await registered();
    const meTaken = await registered();
    const freeEmail = `ce-once-${v7()}@example.test`;
    const requested = await mail.now();
    expect((await changeEmail(meFree.c, freeEmail)).status).toBe(202);
    expect((await changeEmail(meTaken.c, taken.email)).status).toBe(202);
    const confirmFree = await mail.waitFor(meFree.email, {
      subject: CONFIRM_SUBJECT,
      after: requested,
    });
    const confirmTaken = await mail.waitFor(meTaken.email, {
      subject: CONFIRM_SUBJECT,
      after: requested,
    });
    const clicked = await mail.now();
    const shapes: unknown[] = [];
    for (const link of [verifyLink(confirmFree), verifyLink(confirmTaken)])
      for (let i = 0; i < 3; i++) {
        // JWT của Better Auth có `iat` theo GIÂY: hai lần bấm trong cùng một giây mint ra CÙNG một token xác thực và
        // tự trùng khoá. Cách nhau > 1 s để mỗi lần bấm là một token mới, đúng kịch bản dội thư (review I1).
        if (i > 0)
          await new Promise((r) => setTimeout(r, JWT_IAT_RESOLUTION_MS));
        const t0 = performance.now();
        // Mỗi lần bấm một client (một IP): khử trùng phải đến từ token, không từ rate limit.
        const r = await client().request('get', link, { cookie: false });
        expect(performance.now() - t0).toBeGreaterThanOrEqual(FLOOR_MS);
        shapes.push({
          status: r.status,
          body: r.text,
          location: (r.headers as Record<string, string | undefined>).location,
        });
      }
    expect(new Set(shapes.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(
      await settledMail(freeEmail, VERIFY_SUBJECT, clicked, 1),
    ).toHaveLength(1);
    expect(
      await settledMail(taken.email, EXISTS_SUBJECT, clicked, 1),
    ).toHaveLength(1);
    await noMailTo(taken.email, VERIFY_SUBJECT, clicked);
  });

  it('S2-R68: /verify-email is rate limited per IP by its own rule (AUTH_VERIFY_EMAIL_RATE_MAX, 429 problem+json)', async () => {
    const { email, c } = await registered();
    const started = await mail.now();
    expect((await changeEmail(c, `ce-rl-${v7()}@example.test`)).status).toBe(
      202,
    );
    const confirm = await mail.waitFor(email, {
      subject: CONFIRM_SUBJECT,
      after: started,
    });
    const sameIp = client();
    const codes: number[] = [];
    let type: string | undefined;
    for (let i = 0; i < VERIFY_EMAIL_RATE_MAX + 1; i++) {
      const r = await sameIp.request('get', verifyLink(confirm), {
        cookie: false,
      });
      codes.push(r.status);
      if (r.status === 429)
        type = (r.headers as Record<string, string | undefined>)[
          'content-type'
        ];
    }
    expect(codes.slice(0, VERIFY_EMAIL_RATE_MAX).every((s) => s < 400)).toBe(
      true,
    );
    expect(codes[VERIFY_EMAIL_RATE_MAX]).toBe(429);
    expect(type).toContain('application/problem+json');
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
    const started = await mail.now();
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
