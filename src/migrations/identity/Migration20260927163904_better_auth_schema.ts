import { Migration } from '@mikro-orm/migrations';

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

/**
 * Schema `auth` của Better Auth 1.7.6 + cột/bảng của mình (spec SP2 §5.3, ADR 0010 S3).
 * SQL gốc: `pnpm auth:generate` trên schema `auth` trống (kết quả trùng S3a từng byte). Kiểu, NULL và default của
 * mọi cột giữ đúng SQL gốc; chỉ sửa những điểm dưới đây (mỗi dòng một lý do, spec §5.3 bước 4, review Task 26):
 * - Mọi `id`: `DEFAULT pg_catalog.gen_random_uuid()` → `DEFAULT uuidv7()` (D3, ADR 0009: id do DB sinh, v7; nhánh (A)
 *   của S3: `advanced.database.generateId: 'uuid'`).
 * - `account`: UNIQUE (provider_id, account_id) (spec cha §11: UNIQUE(issuer, subject)). `"user".email` đã UNIQUE ở SQL gốc.
 * - `apikey.reference_id`: `text` → `uuid` + FK → "user"(id) ON DELETE CASCADE (key thuộc hẳn user, `references: 'user'`,
 *   A.7). Kiểm schema của Better Auth không so kiểu (S3b), nên đổi kiểu không làm hỏng thư viện.
 * - `"user".registered_event_emitted_at` NULL: marker bền của event identity.user.registered (spec §5.10). Nullable nên
 *   `validateSchema` không chặn (chỉ chặn cột NOT NULL không default, S3b).
 * - `two_factor`: UNIQUE (user_id) (review I1). Plugin giữ một dòng mỗi user (enable: findOne theo userId rồi update
 *   hoặc create, `plugins/two-factor/index.mjs:125-167`; disable xoá theo userId) nhưng không khoá: hai lần enable song
 *   song cùng INSERT, để lại hai secret và bộ đếm khoá bị chia đôi. Có ràng buộc thì lần thua nhận 23505 (→ 503 ở mount).
 *   Index của UNIQUE thay `two_factor_user_id_idx` của SQL gốc (cùng query `WHERE user_id`).
 * - Cờ bảo mật NOT NULL + default đúng `defaultValue` của schema plugin 1.7.6 (review I2, ruling S2-R26: cờ bảo mật
 *   nullable không bao giờ được fail-open). NULL làm thư viện mở cửa: `failed_verification_count` NULL + 1 = NULL nên
 *   khoá 2FA không bao giờ kích hoạt; `apikey.enabled` chỉ chặn khi `=== false`; `two_factor.verified` coi NULL là đã
 *   xác minh. Better Auth không bao giờ ghi NULL vào các cột này: lúc create adapter điền `defaultValue` khi thiếu
 *   (`@better-auth/core/dist/db/adapter/utils.mjs`), các đường ghi khác chỉ ghi boolean/0/+1:
 *   - `two_factor.verified` NOT NULL DEFAULT true; `failed_verification_count` NOT NULL DEFAULT 0 CHECK (>= 0) (chỉ +1
 *     hoặc đặt lại 0, `verify-two-factor.mjs:146,168,199`);
 *   - `apikey.enabled` NOT NULL DEFAULT true (create ghi `true`, update chỉ nhận `z.boolean().optional()`);
 *   - `"user".two_factor_enabled`, `banned` NOT NULL DEFAULT false (schema plugin `defaultValue: false`, ban/unban ghi
 *     boolean). `auth check schema` không so NULL/CHECK/UNIQUE (`schema-diff.mjs`), và cột có DEFAULT nên không bị chặn.
 * - Bỏ hai index của SQL gốc không có query nào dùng (review M1): `two_factor_secret_idx` (1.7.6 không lọc theo
 *   `secret`, cột là ciphertext ngẫu nhiên) và `apikey_config_id_idx` (config_id hầu như luôn 'default', plugin so trong
 *   bộ nhớ sau khi tra theo id/key). `auth check schema` không so index (S3c), đã chạy lại: exit 0.
 * - `login_attempts`: DDL đúng của RateLimiterPostgres (A.9: INSERT … VALUES theo vị trí 3 cột, nên không có
 *   created_at/updated_at), dùng `tableCreated: true`.
 * - Index thêm, mỗi index gắn với một query (chú thích tại chỗ). Index còn lại của SQL gốc phục vụ query của thư viện
 *   (tra theo user_id, identifier, reference_id, key).
 * - `"user".email`: CHECK dạng chuẩn `user_email_canonical_ck` (final review M4): email là khoá của lockout, kiểm tài khoản
 *   đã có và reclaim (`findUserByEmail(normalizeEmail(x))`), nên UNIQUE so từng byte chỉ đúng khi mọi dòng đã ở dạng
 *   chuẩn. Ép `email = lower(btrim(email))` và `email IS NFC NORMALIZED` (Postgres ≥ 13, DB UTF8). Yếu hơn
 *   `normalizeEmail` (`trim().toLowerCase().normalize('NFC')`: trim JS cắt mọi khoảng trắng, `btrim` chỉ cắt dấu cách;
 *   chuỗi đã hạ chữ thường giữ nguyên qua `lower`), nên không bao giờ từ chối kết quả của nó. Better Auth 1.7.6 chỉ
 *   `toLowerCase()` ở internal adapter (`createUser`/`updateUser`), không trim/NFC: route trong `EMAIL_FIELDS_BY_PATH`
 *   đã chuẩn hoá trước, đường OAuth/admin với email chưa chuẩn bị DB từ chối (23514) thay vì lưu lệch.
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
 * |            |      | trạng thái hiện tại của chính dòng (khoá 2FA có sẵn, S4), không lệch 3NF; {user_id} cũng là khoá
 * |            |      | ứng viên (UNIQUE, một dòng mỗi user) nên two_factor BCNF về phụ thuộc hàm
 * | apikey | {id} (key chỉ có index thường, không UNIQUE, S3a) | permissions/metadata JSON (SP2 không đọc); start/prefix là
 * |        |      | snapshot phần đầu key (key chỉ lưu dạng băm); config_id chọn cấu hình plugin, không lệch
 * | jwks | {id} | alg, crv dẫn xuất được từ khoá (tv; chỉ plugin jwt ghi cùng lúc với cặp khoá, không bao giờ sửa)
 * | rate_limit | {id}, {key} | key ghép IP + path; last_request bigint epoch ms (tv)
 * | login_attempts | {key} | key ghép loại + hash + số cửa sổ; expire bigint ms; points âm được khi refund. BCNF về phụ
 * |                |       | thuộc hàm; hình dạng do rate-limiter-flexible quy định (A.9), mọi logic trên key ở login-lockout.ts
 * |                |       | Dòng thứ hai `tickets:<loại>:<hash>:w<cửa sổ>:t<uuid>` (points = 1, expire chép từ dòng tổng
 * |                |       | hợp) là biên nhận refund, không phải bộ đếm — xem spec §5.16
 * Cơ chế nhất quán: `pnpm auth:check` (`auth check schema`, CI Task 48) + validateSchema lúc chạy; test catalog
 * (`auth-schema.spec.ts`, `normalization-inventory.spec.ts`) so cột, kiểu id, ràng buộc, NOT NULL/default, index và grant.
 */
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
    two_factor_enabled boolean NOT NULL DEFAULT false,
    role text,
    banned boolean NOT NULL DEFAULT false,
    ban_reason text,
    ban_expires timestamptz,
    registered_event_emitted_at timestamptz NULL,
    CONSTRAINT user_email_canonical_ck CHECK (email = lower(btrim(email)) AND email IS NFC NORMALIZED));`);
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
    verified boolean NOT NULL DEFAULT true,
    failed_verification_count integer NOT NULL DEFAULT 0
      CONSTRAINT two_factor_failed_verification_count_check CHECK (failed_verification_count >= 0),
    locked_until timestamptz,
    CONSTRAINT two_factor_user_id_unique UNIQUE (user_id));`);
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
    enabled boolean NOT NULL DEFAULT true,
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

    // Index của SQL gốc có query của thư viện dùng (two_factor.user_id đã có index của UNIQUE).
    this.addSql(`CREATE INDEX session_user_id_idx ON auth.session (user_id);`);
    this.addSql(`CREATE INDEX account_user_id_idx ON auth.account (user_id);`);
    this.addSql(
      `CREATE INDEX verification_identifier_idx ON auth.verification (identifier);`,
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
    // Cron identity.purge-expired trên rate_limit: victim CTE là
    // `SELECT id FROM auth.rate_limit WHERE last_request < $2 ORDER BY last_request LIMIT $1 FOR UPDATE SKIP LOCKED`
    // (pg-auth-housekeeping.ts); không có index thì mỗi batch (tới purgeMaxBatches lần) là seq scan + sort
    // trên toàn bảng rate_limit, bảng lớn dần theo traffic (mỗi IP/route một dòng). Review M9.
    this.addSql(
      `CREATE INDEX rate_limit_last_request_idx ON auth.rate_limit (last_request);`,
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
