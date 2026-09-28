import { Migration } from '@mikro-orm/migrations';

/**
 * S2-R76 (final review C2): marker bền của lần reclaim S2-R40 gần nhất của một user. Reclaim (link xác thực email hoặc
 * token đặt lại mật khẩu trên user CHƯA xác thực) gỡ liên kết IdP, session và API key, nhưng không thu hồi được token đổi
 * email: đó là JWT không trạng thái, sống `AUTH_EMAIL_TOKEN_TTL_SEC`. `/verify-email` từ chối token có `updateTo` mà
 * `iat` trước giây của `reclaimed_at` (`auth-hooks.ts`, `issuedBeforeReclaim`).
 *
 * Bảng chuẩn hoá (spec §5.16a):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | auth.user_reclaim | {user_id} | user_id → reclaimed_at, created_at (chỉ khoá → cột) | BCNF |
 * Không lệch: một dòng mỗi user, không cột dẫn xuất, không đa trị. Không trùng với dữ liệu nào khác (reclaim không để
 * lại dấu vết ở bảng khác: nó chỉ xoá).
 *
 * Lựa chọn và lý do:
 * - Bảng riêng, không phải cột trên `auth."user"`: bảng của Better Auth giữ đúng hình dạng thư viện (spec §5.16b).
 *   (N3: migration `better_auth_schema` VẪN bị sửa tại chỗ sau đó — add-on DB final review M4, 52fd544/728cc8b, thêm
 *   CHECK `user_email_canonical_ck` — vì nhánh này chưa merge/ship; xem "reset local DBs" bên dưới.)
 * - PK `user_id` (không có surrogate `BIGINT IDENTITY`): dòng là phần mở rộng 1-1 của user, mọi truy cập theo user;
 *   một id riêng không có query nào dùng. PK cũng là index của hai query: upsert `ON CONFLICT (user_id)` trong
 *   transaction reclaim (`unverified-links.ts`, `revoke`) và `JOIN … ON r.user_id = u.id` sau khi tra user theo email
 *   (UNIQUE sẵn có của `"user".email`, `lastReclaim`).
 * - FK → `"user"(id) ON DELETE CASCADE`: marker thuộc hẳn về user, không phải bản ghi tài chính/kiểm toán; xoá user thì
 *   marker vô nghĩa. Hành động của FK chạy với quyền chủ bảng, nên `auth_user` không cần `DELETE`.
 * - `reclaimed_at` là thời điểm cập nhật của dòng (chỉ cột này đổi), nên không có `updated_at` riêng (sẽ là bản sao).
 *   `created_at` = lần reclaim đầu. `CHECK (reclaimed_at >= created_at)`.
 * - Grant đúng nhu cầu: `SELECT` (tra marker, và `ON CONFLICT` cần đọc cột khoá), `INSERT`, `UPDATE (reclaimed_at)`
 *   theo cột. Không `DELETE`, không `UPDATE` cột khác.
 * - Không dọn theo thời gian: tối đa một dòng mỗi user từng bị reclaim; xoá theo user qua cascade.
 *
 * Khoá: bảng mới, rỗng. `CREATE TABLE … REFERENCES auth."user"` lấy `SHARE ROW EXCLUSIVE` trên `"user"` trong thời gian
 * tạo bảng (không quét dữ liệu), chặn ghi vào `"user"` trong mili giây. Không cần expand/backfill/contract.
 */
export class Migration20260928072715_user_reclaim extends Migration {
  override name = 'Migration20260928072715_user_reclaim';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth.user_reclaim (
    user_id uuid NOT NULL PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
    reclaimed_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT user_reclaim_reclaimed_at_check CHECK (reclaimed_at >= created_at));`);
    this.addSql(`GRANT SELECT, INSERT ON auth.user_reclaim TO auth_user;`);
    this.addSql(
      `GRANT UPDATE (reclaimed_at) ON auth.user_reclaim TO auth_user;`,
    );
  }

  override down(): void | Promise<void> {
    // DROP TABLE xoá luôn PK, FK, CHECK và mọi grant (kể cả grant theo cột).
    this.addSql(`DROP TABLE auth.user_reclaim;`);
  }
}
