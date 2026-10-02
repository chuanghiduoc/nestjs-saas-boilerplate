import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng migration + `auth-hooks.ts`, §9.7 (2), §6.13 bảng 3D): dấu step-up 2FA TRONG session.
 * Một dòng = "session này vừa chứng minh factor hiện tại" (verify-totp / verify-backup-code gửi khi đã có session).
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | auth.session_second_factor | {session_id} | — | BCNF |
 * `verified_at` là lần step-up gần nhất, `method` là phương thức của CHÍNH lần đó (ghi cùng câu upsert), `created_at` là
 * lần đầu. Ràng buộc liên bảng "factor thuộc user của session" do câu ghi duy nhất bảo đảm (join `tf.user_id =
 * s.user_id`) và mọi câu đọc đều join qua user của session.
 *
 * FK: cả hai `ON DELETE CASCADE` (dòng thuộc hẳn session và factor): thu hồi session, gỡ/thay factor (disable, lệnh reset)
 * xoá dấu trong cùng câu lệnh (T-35); kiểm FK giữ `FOR KEY SHARE` trên dòng factor nên câu ghi dấu và câu xoá factor tự
 * tuần tự hoá (T-37). Không trigger, không hàm.
 *
 * Index (mỗi cái một query): PK `session_id` → mọi câu đọc dấu (theo session) và upsert; `session_second_factor_two_factor_idx`
 * → câu `DELETE … WHERE two_factor_id = $1` của hành động CASCADE khi xoá factor.
 *
 * Khoá (giữ tới hết lô 3D, `allOrNothing`): `SHARE ROW EXCLUSIVE` trên `auth.session` và `auth.two_factor` (REFERENCES):
 * đăng nhập (tạo session) và bật/tắt 2FA chờ tới hết lô — chạy trong cửa sổ ít ghi (runbook, spec §6.13).
 */
export class Migration20261002121520_session_second_factor extends Migration {
  override name = 'Migration20261002121520_session_second_factor';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth.session_second_factor (
    session_id uuid PRIMARY KEY REFERENCES auth.session (id) ON DELETE CASCADE,
    two_factor_id uuid NOT NULL REFERENCES auth.two_factor (id) ON DELETE CASCADE,
    method text NOT NULL CONSTRAINT session_second_factor_method_ck CHECK (method IN ('totp', 'backup_code')),
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());`);
    this.addSql(
      `CREATE INDEX session_second_factor_two_factor_idx ON auth.session_second_factor (two_factor_id);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session_second_factor TO auth_user;`,
    );
  }

  override down(): void | Promise<void> {
    // Dấu là trạng thái ngắn hạn (nhân viên step-up lại); DROP TABLE xoá index, FK, CHECK và grant.
    this.addSql(`DROP TABLE auth.session_second_factor;`);
  }
}
