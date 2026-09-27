import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type pg from 'pg';
import { IDENTITY_METER, identitySpan } from '../../identity-telemetry.js';

/** Provider id của tài khoản mật khẩu (Better Auth): không bao giờ bị gỡ. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/** Luồng CỦA MÌNH vừa chứng minh chủ email (S2-R40). */
export type ReclaimTrigger = 'email-verification' | 'password-reset';

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
 * nguyên tử. Còn lại (đã biết, ghi báo cáo): một lần đăng nhập IdP của kẻ tấn công ĐANG chạy dở (đã đọc dòng
 * `account` trước câu lệnh này) vẫn có thể ghi session sau khi câu lệnh commit; lần đăng nhập sau thì không.
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
    trustedProviders: readonly string[],
  ) {
    this.keep = [CREDENTIAL_PROVIDER_ID, ...trustedProviders];
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
    this.reclaimedTotal.add(1, { trigger });
    this.logger.warn(
      {
        event: 'identity_account_reclaimed',
        trigger,
        userId,
        accountsUnlinked: row.accounts,
        sessionsRevoked: row.sessions,
      },
      'untrusted provider links removed and sessions revoked after email ownership was proven',
    );
  }
}
