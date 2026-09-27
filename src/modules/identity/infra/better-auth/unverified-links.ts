import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type pg from 'pg';
import { IDENTITY_METER, identitySpan } from '../../identity-telemetry.js';

/** Provider id của tài khoản mật khẩu (Better Auth): không bao giờ bị gỡ. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/** Luồng CỦA MÌNH vừa chứng minh chủ email (S2-R40). */
export type ReclaimTrigger =
  'email-verification' | 'change-email-verification' | 'password-reset';
/** Phân loại của metric/log; `late-session` là hàng rào sau reclaim (S2-R44 I1). */
type ReclaimEvent = ReclaimTrigger | 'late-session';

/**
 * Chống chiếm tài khoản trước (S2-R40). Kẻ tấn công đăng nhập qua IdP KHÔNG tin cậy bằng email của nạn nhân:
 * Better Auth tạo user `emailVerified=false` (mapper ép, `profile-mapper.ts`) kèm dòng `account` của IdP đó.
 * Khi nạn nhân chứng minh chủ email qua luồng của mình (link xác thực, token đặt lại mật khẩu), gỡ các liên kết
 * provider không tin cậy và thu hồi mọi session của user, để IdP của kẻ tấn công không còn vào được tài khoản.
 *
 * "Tạo khi email chưa xác thực" = user VẪN chưa xác thực tại thời điểm chạy: provider không tin cậy không bao giờ
 * liên kết được vào user đã xác thực (`requireLocalEmailVerified`, `disableImplicitLinking`), nên mọi liên kết như
 * vậy đều có từ lúc chưa xác thực. User đã xác thực thì không đụng gì (liên kết tường minh của chính chủ được giữ).
 *
 * Race: điều kiện "chưa xác thực" nằm TRONG câu lệnh, dưới `FOR UPDATE` trên dòng user, nên không có
 * check-then-act với một lần xác thực/liên kết song song; một câu lệnh nên gỡ liên kết và thu hồi session là
 * nguyên tử. Một lần đăng nhập IdP ĐANG chạy dở (đã đọc dòng `account` trước câu lệnh này) ghi session sau
 * khi reclaim commit: `fenceLateSession` (S2-R44 I1) xoá session đó.
 *
 * Không dùng `revokeUnprovenAccountAccess` có sẵn (`better-auth/dist/db/revoke-unproven-account-access.mjs`,
 * chỉ magic-link và email-otp gọi) vì (M6):
 * - nó xoá MỌI account, kể cả `credential` (luồng reset vừa đặt mật khẩu) và provider tin cậy (ruling chỉ gỡ
 *   provider không tin cậy);
 * - nó tự đặt `emailVerified = true` (reset mật khẩu không được làm việc đó);
 * - nó không nguyên tử: đọc user rồi xoá từng account, xoá session, cập nhật user thành nhiều câu riêng; "khoá"
 *   là một dòng verification hết hạn sau 5 s, bên chờ chỉ chờ tối đa 2 s rồi trả về dù dọn dẹp chưa xong.
 */
export class UnverifiedLinkRevoker {
  private readonly logger = new Logger(UnverifiedLinkRevoker.name);
  private readonly reclaimedTotal = metrics
    .getMeter(IDENTITY_METER)
    .createCounter('identity_account_reclaimed_total', {
      description:
        'Unverified accounts reclaimed by an email-ownership proof: untrusted provider links removed and sessions revoked',
    });
  private readonly keep: readonly string[];

  constructor(
    private readonly pool: pg.Pool,
    private readonly trustedProviders: readonly string[],
  ) {
    this.keep = [CREDENTIAL_PROVIDER_ID, ...trustedProviders];
  }

  isTrusted(providerId: string): boolean {
    return this.trustedProviders.includes(providerId);
  }

  /** Lỗi DB ném nguyên cho caller: luồng xác thực/đặt lại dừng lại (fail closed), token vẫn dùng lại được. */
  async revoke(userId: string, trigger: ReclaimTrigger): Promise<void> {
    const { rows } = await identitySpan('identity.account.reclaim', () =>
      this.pool.query<{ accounts: number; sessions: number }>(
        `WITH target AS (
           SELECT id FROM auth."user" WHERE id = $1 AND NOT email_verified FOR UPDATE
         ), unlinked AS (
           DELETE FROM auth.account a USING target
            WHERE a.user_id = target.id AND a.provider_id <> ALL($2::text[]) RETURNING 1
         ), revoked AS (
           DELETE FROM auth.session s USING target WHERE s.user_id = target.id RETURNING 1
         )
         SELECT (SELECT count(*) FROM unlinked)::int AS accounts,
                (SELECT count(*) FROM revoked)::int AS sessions`,
        [userId, this.keep],
      ),
    );
    const row = rows[0];
    if (!row) throw new Error('account reclaim returned no row');
    if (row.accounts === 0 && row.sessions === 0) return;
    this.record(trigger, userId, row.accounts, row.sessions);
  }

  /**
   * S2-R44 I1: hàng rào cho session mà một lần đăng nhập qua provider KHÔNG tin cậy vừa ghi
   * (`databaseHooks.session.create.after`, chạy sau commit). Race cần đóng: lần đăng nhập đọc dòng `account` ở t0,
   * reclaim gỡ link và commit ở t1, lần đăng nhập ghi session ở t2 — session đó sống trên tài khoản đã được đòi lại.
   *
   * Hai câu lệnh trong MỘT transaction (READ COMMITTED):
   * 1. `FOR SHARE` trên dòng user: xung đột với `FOR UPDATE` của reclaim, nên chờ reclaim đang chạy commit xong.
   * 2. `DELETE` session nếu link của provider không còn: câu lệnh MỚI nên có snapshot mới, thấy kết quả reclaim.
   * Reclaim commit trước bước 1 → bước 2 thấy link đã mất; reclaim bắt đầu sau khi session commit → chính reclaim
   * thấy và xoá session. Không dùng `create.before`: kiểm trước khi insert lại là check-then-insert.
   * Trả `true` nếu session bị xoá. Lỗi DB ném lên (lần đăng nhập thất bại, không cấp cookie: fail closed).
   */
  async fenceLateSession(
    session: { id: string; userId: string },
    providerId: string,
  ): Promise<boolean> {
    const deleted = await identitySpan(
      'identity.account.fence_late_session',
      async () => {
        const client = await this.pool.connect();
        let broken: Error | undefined;
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT 1 FROM auth."user" WHERE id = $1 FOR SHARE`,
            [session.userId],
          );
          const result = await client.query(
            `DELETE FROM auth.session WHERE id = $2 AND NOT EXISTS (
             SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id = $3)`,
            [session.userId, session.id, providerId],
          );
          await client.query('COMMIT');
          return result.rowCount === 1;
        } catch (err) {
          // ROLLBACK hỏng thì huỷ connection (release(err)) thay vì trả một client đang trong transaction về pool.
          await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
            broken =
              rollbackErr instanceof Error
                ? rollbackErr
                : new Error('ROLLBACK failed');
          });
          throw err;
        } finally {
          client.release(broken);
        }
      },
    );
    if (deleted) this.record('late-session', session.userId, 0, 1);
    return deleted;
  }

  private record(
    trigger: ReclaimEvent,
    userId: string,
    accounts: number,
    sessions: number,
  ): void {
    this.reclaimedTotal.add(1, { trigger });
    this.logger.warn(
      {
        event: 'identity_account_reclaimed',
        trigger,
        userId,
        accountsUnlinked: accounts,
        sessionsRevoked: sessions,
      },
      'untrusted provider access removed after email ownership was proven',
    );
  }
}
