import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type pg from 'pg';
import { IDENTITY_METER, identitySpan } from '../../identity-telemetry.js';

/** Provider id của tài khoản mật khẩu (Better Auth). */
const CREDENTIAL_PROVIDER_ID = 'credential';

/** Luồng CỦA MÌNH vừa chứng minh chủ email (S2-R40). */
export type ReclaimTrigger =
  'email-verification' | 'change-email-verification' | 'password-reset';
/** Phân loại của metric/log; `late-session` là hàng rào sau reclaim (S2-R44 I1). */
type ReclaimEvent = ReclaimTrigger | 'late-session';

/**
 * Chống chiếm tài khoản trước (S2-R40). Kẻ tấn công đăng nhập qua IdP bằng email của nạn nhân khi IdP không
 * khẳng định email đã xác thực: Better Auth tạo user `emailVerified=false` (mapper, `profile-mapper.ts`) kèm dòng
 * `account` của IdP đó. Khi nạn nhân chứng minh chủ email qua luồng của mình (link xác thực, token đặt lại mật
 * khẩu), gỡ MỌI liên kết không phải `credential` và thu hồi mọi session của user.
 *
 * S2-R48: chỉ `credential` được giữ, kể cả liên kết của provider TIN CẬY. Với `requireLocalEmailVerified: true`,
 * Better Auth từ chối mọi liên kết ngầm vào user chưa xác thực (`oauth2/link-account.mjs:139`), và `/link-social`
 * đòi `userInfo.emailVerified` (`link-account.mjs:43`) mà mapper chỉ đặt cho provider tin cậy có
 * `email_verified === true` — liên kết kiểu đó đã là bằng chứng email và làm user thành đã xác thực. Vậy một liên
 * kết không phải credential trên user CHƯA xác thực chỉ có thể đến từ lần ĐĂNG KÝ qua một provider khẳng định
 * `email_verified=false`: chưa được chứng minh (spec §5.4). User đã xác thực thì không đụng gì.
 *
 * Race (review lại R1): reclaim là một transaction KHOÁ TRƯỚC, XOÁ SAU. `SELECT … FOR UPDATE` trên dòng user (kèm
 * điều kiện chưa xác thực) rồi mới `DELETE`; mỗi `DELETE` là câu lệnh mới nên snapshot của nó lấy SAU khi có khoá.
 * Bản CTE một câu cũ dùng snapshot lấy TRƯỚC khi chờ khoá, nên bỏ sót session commit trong lúc chờ. Bất biến:
 * - session commit TRƯỚC khi reclaim có khoá → `DELETE session` của reclaim thấy và xoá nó;
 * - session commit SAU → phải chờ reclaim commit (FK của INSERT lấy `FOR KEY SHARE`, xung đột với `FOR UPDATE`), nên
 *   hàng rào của nó (`fenceLateSession`) chạy sau commit của reclaim và thấy liên kết đã mất.
 *
 * Không dùng `revokeUnprovenAccountAccess` có sẵn (`better-auth/dist/db/revoke-unproven-account-access.mjs`,
 * chỉ magic-link và email-otp gọi) vì (M6):
 * - nó xoá MỌI account, kể cả `credential` (trên `/verify-email` sẽ xoá mật khẩu của chính chủ ở mỗi lần đăng ký);
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
        'Unverified accounts reclaimed by an email-ownership proof: non-credential links removed and sessions revoked',
    });

  constructor(private readonly pool: pg.Pool) {}

  /** Lỗi DB ném nguyên cho caller: luồng xác thực/đặt lại dừng lại (fail closed), token vẫn dùng lại được. */
  async revoke(userId: string, trigger: ReclaimTrigger): Promise<void> {
    const counts = await identitySpan('identity.account.reclaim', () =>
      this.transaction(async (client) => {
        const locked = await client.query(
          `SELECT 1 FROM auth."user" WHERE id = $1 AND NOT email_verified FOR UPDATE`,
          [userId],
        );
        if (locked.rowCount === 0) return undefined;
        const accounts = await client.query(
          `DELETE FROM auth.account WHERE user_id = $1 AND provider_id <> $2`,
          [userId, CREDENTIAL_PROVIDER_ID],
        );
        const sessions = await client.query(
          `DELETE FROM auth.session WHERE user_id = $1`,
          [userId],
        );
        return {
          accounts: accounts.rowCount ?? 0,
          sessions: sessions.rowCount ?? 0,
        };
      }),
    );
    if (!counts || (counts.accounts === 0 && counts.sessions === 0)) return;
    this.record(trigger, userId, counts.accounts, counts.sessions);
  }

  /**
   * S2-R44 I1: hàng rào cho session mà một lần đăng nhập OAuth vừa ghi (`databaseHooks.session.create.after`,
   * chạy ngay sau khi INSERT session autocommit, TRƯỚC `setSessionCookie`). Race cần đóng: lần đăng nhập đọc dòng
   * `account` ở t0, reclaim gỡ liên kết và commit ở t1, lần đăng nhập ghi session ở t2.
   *
   * Hai câu lệnh trong MỘT transaction (READ COMMITTED):
   * 1. `FOR SHARE` trên dòng user. Nó xung đột với `FOR UPDATE` của reclaim: khi reclaim ĐANG giữ khoá, hàng rào chờ
   *    reclaim commit. Nó không xung đột với `FOR KEY SHARE` của các INSERT session khác, nên có thể chạy trước một
   *    reclaim còn đang CHỜ khoá — an toàn vì session này đã commit trước khi reclaim có khoá, nên `DELETE session`
   *    của reclaim (câu lệnh sau khoá) thấy và xoá nó.
   * 2. `DELETE` session nếu liên kết của provider không còn: câu lệnh MỚI nên có snapshot mới, thấy kết quả reclaim.
   * 3. Không xoá được thì kiểm session CÒN tồn tại không (Task 39): session commit TRƯỚC khi reclaim có khoá nhưng
   *    hàng rào chạy SAU commit của reclaim (xếp hàng sau reclaim trên dòng user) thì reclaim đã xoá nó. Lần đăng nhập
   *    đó cũng hoàn tất sau reclaim, nên phải bị từ chối như trên: không cấp cookie của session đã chết kèm redirect
   *    thành công.
   * Không dùng `create.before`: kiểm trước khi insert lại là check-then-insert.
   * Trả `true` nếu session không còn sống (hàng rào xoá, hoặc reclaim đã xoá). Lỗi DB ném lên (lần đăng nhập thất
   * bại, không cấp cookie: fail closed).
   */
  async fenceLateSession(
    session: { id: string; userId: string },
    providerId: string,
  ): Promise<boolean> {
    const outcome = await identitySpan(
      'identity.account.fence_late_session',
      () =>
        this.transaction(async (client) => {
          await client.query(
            `SELECT 1 FROM auth."user" WHERE id = $1 FOR SHARE`,
            [session.userId],
          );
          const result = await client.query(
            `DELETE FROM auth.session WHERE id = $2 AND NOT EXISTS (
               SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id = $3)`,
            [session.userId, session.id, providerId],
          );
          if (result.rowCount === 1) return 'deleted';
          const live = await client.query(
            `SELECT 1 FROM auth.session WHERE id = $1`,
            [session.id],
          );
          return live.rowCount === 0 ? 'already-revoked' : 'live';
        }),
    );
    // `already-revoked` đã được reclaim ghi metric/log (nó xoá session); chỉ ghi phần hàng rào tự xoá.
    if (outcome === 'deleted')
      this.record('late-session', session.userId, 0, 1);
    return outcome !== 'live';
  }

  /** BEGIN/COMMIT trên một client của pool auth; ROLLBACK hỏng thì huỷ connection (`release(err)`). */
  private async transaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
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
      'unproven provider access removed after email ownership was proven',
    );
  }
}
