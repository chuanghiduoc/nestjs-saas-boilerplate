import { Migration } from '@mikro-orm/migrations';

/**
 * S2-R75 (final review notif I1): marker bền của thông báo bảo mật (hiện là 2FA bật/tắt). Thông báo gửi sau commit của
 * Better Auth có thể mất nếu process chết hoặc DB app lỗi giữa commit của auth và dòng `email_deliveries`; thao tác bảo mật
 * không làm lại được (bấm lại thì trạng thái đã đổi, không còn gì để báo), nên marker phải commit CÙNG thay đổi.
 *
 * Vì sao là trigger, không phải hook của Better Auth: better-auth 1.7.6 KHÔNG bọc các endpoint 2FA trong transaction.
 * `/two-factor/enable` (`plugins/two-factor/index.mjs:117,140`), `/two-factor/disable` (`:217`), `/two-factor/verify-totp`
 * (`plugins/two-factor/totp/index.mjs:208`) và `/two-factor/verify-otp` (`plugins/two-factor/otp/index.mjs:226`) gọi thẳng
 * `internalAdapter.updateUser` (`db/internal-adapter.mjs:601`), không có `runWithTransaction` nào quanh chúng (chỉ
 * sign-up, OAuth user/link và consume verification có). `databaseHooks.user.update.before/after` (`db/with-hooks.mjs:44-78`)
 * chạy trước câu UPDATE hoặc sau khi nó đã commit (autocommit), nên không hook nào nằm cùng transaction với việc đổi cờ. Trigger
 * `AFTER UPDATE OF two_factor_enabled` chạy TRONG chính câu UPDATE đó: đổi cờ commit thì marker commit, rollback thì không có
 * marker, trên mọi đường ghi (plugin 2FA, admin, câu SQL tay).
 *
 * Bảng chuẩn hoá (spec §5.16a):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | auth.security_notice | {id} | id → user_id, kind, created_at, notified_at (chỉ khoá → cột) | BCNF |
 * `kind` là trạng thái MỚI tại thời điểm đổi, không dẫn xuất được từ `"user".two_factor_enabled` hiện tại (cờ có thể đổi tiếp).
 * Không lưu email/tên: đọc từ `"user"` lúc gửi (không trùng dữ liệu, không thêm PII).
 *
 * Lựa chọn và lý do:
 * - `id uuid DEFAULT uuidv7()`: quy ước id của schema auth (test `auth-schema.spec.ts`). Id vào khoá idempotency ở một bảng
 *   KHÁC (`public.email_deliveries`, giữ `NOTIFICATIONS_RETENTION_DAYS`); uuid không bao giờ lặp lại kể cả khi bảng này được
 *   tạo lại (down/up, restore), còn IDENTITY sẽ đếm lại từ 1 và thông báo mới bị khử trùng nhầm với thư cũ.
 * - FK → `"user"(id) ON DELETE CASCADE`: marker thuộc hẳn về user (không phải bản ghi tài chính/kiểm toán); user bị xoá thì
 *   không còn ai để báo.
 * - `created_at` = thời điểm đổi 2FA (cùng câu lệnh), dùng làm `occurredAt` của thư. `notified_at` NULL = chưa gửi; cột duy
 *   nhất được cập nhật nên không có `updated_at` riêng (sẽ là bản sao). `CHECK (notified_at >= created_at)`.
 * - `kind` CHECK theo danh sách đóng (`SECURITY_NOTICE_KINDS`).
 * - Index, mỗi cái cho một query: `(user_id)` cho FK cascade khi xoá user và cho đường gửi nhanh (`pendingForUser`);
 *   `(created_at) WHERE notified_at IS NULL` cho cron `identity.reconcile-security-notices` và gauge tuổi backlog;
 *   `(notified_at)` cho purge (`identity.purge-expired`, `notified_at < now() - retention`).
 * - Grant đúng nhu cầu của `auth_user`: `SELECT`, `INSERT` (trigger chạy với quyền của người gọi câu UPDATE), `DELETE`
 *   (purge), `UPDATE (notified_at)` theo cột.
 * - Hàm trigger: `SET search_path` cố định và tên đủ schema (không phụ thuộc search_path của phiên); thu hồi EXECUTE của
 *   PUBLIC như `app_current_org()` (hàm trigger không gọi trực tiếp được, và việc chạy trigger không kiểm EXECUTE).
 *
 * Khoá: bảng mới, rỗng. `CREATE TABLE … REFERENCES auth."user"` và `CREATE TRIGGER` lấy `SHARE ROW EXCLUSIVE` trên `"user"`
 * trong thời gian tạo (không quét dữ liệu), chặn ghi vào `"user"` trong mili giây. Không cần expand/backfill/contract: 2FA đổi
 * TRƯỚC migration không có marker, và thông báo của chúng đã đi (hoặc mất) theo đường cũ.
 */
export class Migration20260928082958_security_notice extends Migration {
  override name = 'Migration20260928082958_security_notice';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth.security_notice (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    kind text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notified_at timestamptz NULL,
    CONSTRAINT security_notice_kind_check CHECK (kind IN ('two_factor_enabled', 'two_factor_disabled')),
    CONSTRAINT security_notice_notified_at_check CHECK (notified_at >= created_at));`);
    this.addSql(
      `CREATE INDEX security_notice_user_id_idx ON auth.security_notice (user_id);`,
    );
    this.addSql(
      `CREATE INDEX security_notice_pending_idx ON auth.security_notice (created_at) WHERE notified_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX security_notice_notified_at_idx ON auth.security_notice (notified_at);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON auth.security_notice TO auth_user;`,
    );
    this.addSql(
      `GRANT UPDATE (notified_at) ON auth.security_notice TO auth_user;`,
    );
    this.addSql(`CREATE FUNCTION auth.record_two_factor_notice() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO auth.security_notice (user_id, kind)
  VALUES (NEW.id, CASE WHEN NEW.two_factor_enabled THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END);
  RETURN NULL;
END;
$$;`);
    this.addSql(
      `REVOKE ALL ON FUNCTION auth.record_two_factor_notice() FROM PUBLIC;`,
    );
    this.addSql(`CREATE TRIGGER user_two_factor_notice_trg
    AFTER UPDATE OF two_factor_enabled ON auth."user"
    FOR EACH ROW WHEN (OLD.two_factor_enabled IS DISTINCT FROM NEW.two_factor_enabled)
    EXECUTE FUNCTION auth.record_two_factor_notice();`);
  }

  override down(): void | Promise<void> {
    // Ngược thứ tự của up. DROP TABLE xoá luôn index, FK, CHECK và mọi grant (kể cả grant theo cột).
    this.addSql(`DROP TRIGGER user_two_factor_notice_trg ON auth."user";`);
    this.addSql(`DROP FUNCTION auth.record_two_factor_notice();`);
    this.addSql(`DROP TABLE auth.security_notice;`);
  }
}
