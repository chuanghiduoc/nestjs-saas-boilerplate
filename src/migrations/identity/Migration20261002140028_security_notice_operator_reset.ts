import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng migration `…_security_notice_operator_reset`, §6.12, §6.13 bảng 3D; r6 N6-3): lệnh vận hành
 * `identity:staff-2fa-reset` ghi marker bền `operator_reset` kèm ticket trong CHÍNH transaction của nó; cron
 * `identity.reconcile-security-notices` của SP2 gửi thư cho chủ tài khoản.
 *
 * Chuẩn hoá (spec §6.12): `auth.security_notice` vẫn BCNF, khoá {id}; `ticket` chỉ phụ thuộc khoá (`id → ticket`), có đúng
 * khi kind = `operator_reset` (`CHECK` hai chiều). Không index mới (không query nào lọc theo ticket; dấu vết lâu dài là log
 * WARN `identity_staff_2fa_reset`).
 *
 * Khoá: `ACCESS EXCLUSIVE` trên `auth.security_notice` trong lúc kiểm hai `CHECK` (bảng marker nhỏ); trigger
 * `user_two_factor_notice_trg` chèn vào bảng này nên bật/tắt 2FA chờ tới hết lô 3D (vốn đã chờ vì `…_session_second_factor`).
 *
 * Down (r7 R7-C1, r8 R8-C3): câu ĐẦU TIÊN lấy `ACCESS EXCLUSIVE` (không nâng khoá giữa chừng), nên guard và câu xoá thấy
 * cùng tập dòng. An toàn khi (a) mọi marker `operator_reset` ở trạng thái cuối VÀ (b) không thư nào của chúng còn
 * `PENDING`/`SENDING` (code cũ `.strict()` không render được `operatorReset`, thư thành FAILED vĩnh viễn). Đọc
 * `public.email_deliveries` là ngoại lệ có tên (chỉ đọc, chỉ ở down; bảng không RLS, thuộc `app_owner`). Đạt → xoá marker
 * `operator_reset` (code cũ không bao giờ đọc marker ở trạng thái cuối), rồi trả schema về hai giá trị.
 */
export class Migration20261002140028_security_notice_operator_reset extends Migration {
  override name = 'Migration20261002140028_security_notice_operator_reset';

  override up(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_kind_check;`,
    );
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_kind_check CHECK (kind IN ('two_factor_enabled', 'two_factor_disabled', 'operator_reset'));`,
    );
    this.addSql(
      `ALTER TABLE auth.security_notice ADD COLUMN ticket text NULL;`,
    );
    // 128 = STAFF_RESET_TICKET_MAX_LENGTH (auth-schema.spec.ts khoá hai bên bằng nhau).
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_ticket_check CHECK ((kind = 'operator_reset') = (ticket IS NOT NULL) AND (ticket IS NULL OR char_length(ticket) BETWEEN 1 AND 128));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`LOCK TABLE auth.security_notice IN ACCESS EXCLUSIVE MODE;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.security_notice n
             WHERE n.kind = 'operator_reset' AND n.notified_at IS NULL AND n.abandoned_at IS NULL)
     OR EXISTS (SELECT 1 FROM auth.security_notice n
                JOIN public.email_deliveries d ON d.idempotency_key = 'two-factor-changed:' || n.user_id || ':' || n.id
                WHERE n.kind = 'operator_reset' AND d.state IN ('PENDING', 'SENDING')) THEN
    RAISE EXCEPTION 'operator_reset markers or mails are not finished: wait for identity.reconcile-security-notices and the mail worker, then run the down again';
  END IF;
END $$;`);
    this.addSql(
      `DELETE FROM auth.security_notice WHERE kind = 'operator_reset';`,
    );
    this.addSql(
      `ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_ticket_check;`,
    );
    this.addSql(`ALTER TABLE auth.security_notice DROP COLUMN ticket;`);
    this.addSql(
      `ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_kind_check;`,
    );
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_kind_check CHECK (kind IN ('two_factor_enabled', 'two_factor_disabled'));`,
    );
  }
}
