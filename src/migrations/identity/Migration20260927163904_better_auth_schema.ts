import { Migration } from '@mikro-orm/migrations';

/**
 * Schema `auth` của Better Auth 1.7.6 + cột/bảng của mình (spec SP2 §5.3, ADR 0010 S3).
 * SQL gốc: `pnpm auth:generate` trên schema `auth` trống (kết quả trùng S3a từng byte). Kiểu, NULL và default của
 * mọi cột giữ đúng SQL gốc; chỉ sửa những điểm dưới đây (mỗi dòng một lý do, spec §5.3 bước 4):
 * - Mọi `id`: `DEFAULT pg_catalog.gen_random_uuid()` → `DEFAULT uuidv7()` (D3, ADR 0009: id do DB sinh, v7; nhánh (A)
 *   của S3: `advanced.database.generateId: 'uuid'`).
 * - `account`: UNIQUE (provider_id, account_id) (spec cha §11: UNIQUE(issuer, subject)). `"user".email` đã UNIQUE ở SQL gốc.
 * - `apikey.reference_id`: `text` → `uuid` + FK → "user"(id) ON DELETE CASCADE (key thuộc hẳn user, `references: 'user'`,
 *   A.7). Kiểm schema của Better Auth không so kiểu (S3b), nên đổi kiểu không làm hỏng thư viện.
 * - `"user".registered_event_emitted_at` NULL: marker bền của event identity.user.registered (spec §5.10). Nullable nên
 *   `validateSchema` không chặn (chỉ chặn cột NOT NULL không default, S3b).
 * - `login_attempts`: DDL đúng của RateLimiterPostgres (A.9: INSERT … VALUES theo vị trí 3 cột, nên không có
 *   created_at/updated_at), dùng `tableCreated: true`.
 * - Index thêm, mỗi index gắn với một query (chú thích tại chỗ). Index của SQL gốc giữ nguyên: thư viện khai báo chúng
 *   (`index: true` trong schema plugin) cho query của chính nó.
 * - GRANT SELECT, INSERT, UPDATE, DELETE cho `auth_user` theo từng bảng (không dựa default privilege).
 * FK session/account/two_factor → "user" ON DELETE CASCADE giữ như SQL gốc: dòng con hoàn toàn thuộc user.
 *
 * Bảng chuẩn hoá (spec §5.16a/b; "tv" = ngoại lệ "schema do thư viện sở hữu": chỉ plugin ghi các cột đó, đổi hình dạng
 * là hỏng thư viện):
 * | "user" | khoá {id}, {email} | lệch (tv): two_factor_enabled dẫn xuất từ two_factor (chỉ plugin twoFactor ghi cả hai);
 * |        |                    | role chuỗi đa trị nối dấu phẩy (app chỉ so 'admin' qua IdentityDirectory); banned/ban_* cờ rời
 * |        |                    | registered_event_emitted_at (của mình): id → marker; một người ghi (UPDATE … WHERE … IS NULL)
 * | session | {id}, {token} | không lệch 3NF; impersonated_by là id user dạng text không FK (tv; D7 tắt impersonation nên luôn NULL)
 * | account | {id}, {provider_id, account_id} | scope đa trị (tài liệu mờ); password chỉ có nghĩa với provider credential
 * | verification | {id} | identifier ghép loại + giá trị (tài liệu mờ; chỉ cron dọn đọc expires_at)
 * | two_factor | {id} | backup_codes một khối mã hoá (tài liệu mờ); verified, failed_verification_count, locked_until là
 * |            |      | trạng thái hiện tại của chính dòng (khoá 2FA có sẵn, S4), không lệch 3NF; "một dòng mỗi user" là
 * |            |      | giả định của plugin, DB không ép (tv)
 * | apikey | {id} (key chỉ có index thường, không UNIQUE, S3a) | permissions/metadata JSON (SP2 không đọc); start/prefix là
 * |        |      | snapshot phần đầu key (key chỉ lưu dạng băm); config_id chọn cấu hình plugin, không lệch
 * | jwks | {id} | alg, crv dẫn xuất được từ khoá (tv; chỉ plugin jwt ghi cùng lúc với cặp khoá, không bao giờ sửa)
 * | rate_limit | {id}, {key} | key ghép IP + path; last_request bigint epoch ms (tv)
 * | login_attempts | {key} | key ghép loại + hash + số cửa sổ; expire bigint ms; points âm được khi refund. BCNF về phụ
 * |                |       | thuộc hàm; hình dạng do rate-limiter-flexible quy định (A.9), mọi logic trên key ở login-lockout.ts
 * Cơ chế nhất quán: `pnpm auth:check` (`auth check schema`, CI Task 48) + validateSchema lúc chạy; test catalog
 * (`auth-schema.spec.ts`, `normalization-inventory.spec.ts`) so cột, kiểu id, ràng buộc, index và grant.
 */
/**
 * Tên bảng đã quote khi cần, theo thứ tự tạo (cha trước con). Migration không import code của module (bất biến theo
 * thời gian), nên danh sách chép lại ở đây; `auth-schema.spec.ts` so với `AUTH_TABLES`.
 */
const AUTH_TABLES_SQL = [
  '"user"',
  'session',
  'account',
  'verification',
  'two_factor',
  'apikey',
  'jwks',
  'rate_limit',
  'login_attempts',
] as const;

export class Migration20260927163904_better_auth_schema extends Migration {
  override name = 'Migration20260927163904_better_auth_schema';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth."user" (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    email_verified boolean NOT NULL,
    image text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    two_factor_enabled boolean,
    role text,
    banned boolean,
    ban_reason text,
    ban_expires timestamptz,
    registered_event_emitted_at timestamptz NULL);`);
    this.addSql(`CREATE TABLE auth.session (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    token text NOT NULL UNIQUE,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    impersonated_by text);`);
    this.addSql(`CREATE TABLE auth.account (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    password text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT account_provider_id_account_id_unique UNIQUE (provider_id, account_id));`);
    this.addSql(`CREATE TABLE auth.verification (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);`);
    this.addSql(`CREATE TABLE auth.two_factor (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    verified boolean,
    failed_verification_count integer,
    locked_until timestamptz);`);
    this.addSql(`CREATE TABLE auth.apikey (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    config_id text NOT NULL,
    name text,
    start text,
    reference_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    prefix text,
    key text NOT NULL,
    refill_interval integer,
    refill_amount integer,
    last_refill_at timestamptz,
    enabled boolean,
    rate_limit_enabled boolean,
    rate_limit_time_window integer,
    rate_limit_max integer,
    request_count integer,
    remaining integer,
    last_request timestamptz,
    expires_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    permissions text,
    metadata text);`);
    this.addSql(`CREATE TABLE auth.jwks (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz,
    alg text,
    crv text);`);
    this.addSql(`CREATE TABLE auth.rate_limit (
    id uuid DEFAULT uuidv7() NOT NULL PRIMARY KEY,
    key text NOT NULL UNIQUE,
    count integer NOT NULL,
    last_request bigint NOT NULL);`);
    this.addSql(`CREATE TABLE auth.login_attempts (
    key varchar(255) PRIMARY KEY,
    points integer NOT NULL DEFAULT 0,
    expire bigint);`);

    // Index của SQL gốc (thư viện khai báo cho query của nó).
    this.addSql(`CREATE INDEX session_user_id_idx ON auth.session (user_id);`);
    this.addSql(`CREATE INDEX account_user_id_idx ON auth.account (user_id);`);
    this.addSql(
      `CREATE INDEX verification_identifier_idx ON auth.verification (identifier);`,
    );
    this.addSql(
      `CREATE INDEX two_factor_secret_idx ON auth.two_factor (secret);`,
    );
    this.addSql(
      `CREATE INDEX two_factor_user_id_idx ON auth.two_factor (user_id);`,
    );
    this.addSql(
      `CREATE INDEX apikey_config_id_idx ON auth.apikey (config_id);`,
    );
    this.addSql(
      `CREATE INDEX apikey_reference_id_idx ON auth.apikey (reference_id);`,
    );
    this.addSql(`CREATE INDEX apikey_key_idx ON auth.apikey (key);`);
    // Cron identity.purge-expired: xoá theo batch các dòng đã hết hạn.
    this.addSql(
      `CREATE INDEX session_expires_at_idx ON auth.session (expires_at);`,
    );
    this.addSql(
      `CREATE INDEX verification_expires_at_idx ON auth.verification (expires_at);`,
    );
    this.addSql(
      `CREATE INDEX login_attempts_expire_idx ON auth.login_attempts (expire);`,
    );
    // Cron identity.reconcile-registered: chỉ user chưa có marker (index nhỏ, spec §5.10).
    this.addSql(
      `CREATE INDEX user_unmarked_registered_idx ON auth."user" (created_at) WHERE registered_event_emitted_at IS NULL;`,
    );

    for (const t of AUTH_TABLES_SQL)
      this.addSql(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON auth.${t} TO auth_user;`,
      );
  }

  override down(): void | Promise<void> {
    // Thứ tự FK ngược; DROP TABLE xoá luôn index, ràng buộc và grant.
    for (const t of [...AUTH_TABLES_SQL].reverse())
      this.addSql(`DROP TABLE auth.${t};`);
  }
}
