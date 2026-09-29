#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_RELAY_PASSWORD:?required}" "${APP_AUTH_PASSWORD:?required}"
: "${APP_USER_STATEMENT_TIMEOUT_MS:?required}" "${APP_RELAY_STATEMENT_TIMEOUT_MS:?required}" "${AUTH_USER_STATEMENT_TIMEOUT_MS:?required}" "${IDLE_IN_TX_TIMEOUT_MS:?required}"
# DBA production chạy đúng script này (spec SP2 §5.3). Không dựa vào quyền mặc định của PUBLIC:
# PG 15+ chỉ bỏ CREATE trên schema public, vẫn để USAGE, CONNECT và TEMPORARY cho mọi role.
# Chạy lại được (ruling S2-R18): role/schema chỉ tạo khi thiếu, rồi luôn khẳng định lại thuộc tính,
# mật khẩu (xoay mật khẩu = chạy lại với env mới) và mọi quyền. Một transaction: lỗi giữa chừng không
# để lại trạng thái nửa vời.
psql -v ON_ERROR_STOP=1 --single-transaction --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v relay_pw="$APP_RELAY_PASSWORD" -v auth_pw="$APP_AUTH_PASSWORD" \
  -v user_stmt="${APP_USER_STATEMENT_TIMEOUT_MS}ms" -v relay_stmt="${APP_RELAY_STATEMENT_TIMEOUT_MS}ms" -v auth_stmt="${AUTH_USER_STATEMENT_TIMEOUT_MS}ms" \
  -v idle_tx="${IDLE_IN_TX_TIMEOUT_MS}ms" -v db="$POSTGRES_DB" <<'SQL'
-- Biến psql không nội suy trong DO $$ ... $$, nên tạo role thiếu bằng \gexec.
SELECT format('CREATE ROLE %I', r)
FROM unnest(ARRAY['app_owner', 'app_user', 'app_relay', 'auth_user', 'tenancy_definer', 'partition_owner', 'sweep_definer']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE app_owner WITH LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE app_user  WITH LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE app_relay WITH LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE auth_user WITH LOGIN PASSWORD :'auth_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
-- SP3 (ADR 0005, 0017): chủ sở hữu duy nhất của các hàm SECURITY DEFINER chỉ đọc của tenancy. Không đăng nhập được,
-- không BYPASSRLS; chỉ có SELECT theo cột + policy `FOR SELECT TO tenancy_definer USING (true)` do migration cấp.
ALTER ROLE tenancy_definer WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- SP6 (ADR 0005, spec SP6 §3.2): chủ sở hữu mọi bảng partitioned và hàm bảo trì partition (drop partition cần quyền owner,
-- mà runtime không có app_owner).
ALTER ROLE partition_owner WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- SP6 (R-X4): chủ sở hữu duy nhất của MỌI hàm SECURITY DEFINER "quét xuyên org, trả org_id đến hạn" của mọi module/feature.
-- Chỉ có SELECT theo cột + policy `<bảng>_definer_read … FOR SELECT TO sweep_definer USING (true)` do migration cấp.
ALTER ROLE sweep_definer WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

REVOKE CONNECT, TEMPORARY ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_relay, auth_user;
-- Chỉ owner có bảng tạm (test catalog dùng bảng tạm để thử luật RLS).
GRANT TEMPORARY ON DATABASE :"db" TO app_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_relay;
-- CREATE vì migration tạo hàm DƯỚI `SET LOCAL ROLE tenancy_definer` (hàm sinh ra thuộc tenancy_definer). Role NOLOGIN
-- nên không ai đăng nhập bằng nó để tạo đối tượng khác.
GRANT USAGE, CREATE ON SCHEMA public TO tenancy_definer;
-- INHERIT FALSE: app_owner KHÔNG hưởng quyền/policy của tenancy_definer (đọc bảng FORCE RLS), và từ PG 16 không được
-- coi là owner của hàm do tenancy_definer sở hữu, nên mọi DDL trên hàm đó phải `SET LOCAL ROLE` (S3-A31).
-- SET TRUE: migration (app_owner) được `SET ROLE tenancy_definer`. GRANT lặp lại cập nhật option (chạy lại được).
GRANT tenancy_definer TO app_owner WITH INHERIT FALSE, SET TRUE;
-- Cùng lý do với tenancy_definer (S3-A31): migration tạo bảng/hàm DƯỚI `SET LOCAL ROLE <role>`; INHERIT FALSE nên app_owner
-- không hưởng quyền của hai role và mọi DDL trên đối tượng của chúng phải `SET LOCAL ROLE`. GRANT lặp lại cập nhật option.
GRANT USAGE, CREATE ON SCHEMA public TO partition_owner, sweep_definer;
GRANT partition_owner TO app_owner WITH INHERIT FALSE, SET TRUE;
GRANT sweep_definer TO app_owner WITH INHERIT FALSE, SET TRUE;

-- Schema của Better Auth: tạo ở đây để app_owner không cần CREATE trên cả database; migration chỉ tạo/xoá bảng.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION app_owner;
ALTER SCHEMA auth OWNER TO app_owner;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO auth_user;
-- Cơ chế chọn schema của adapter bọc (spec §5.9): query không ghi schema không bao giờ rơi vào public.
ALTER ROLE auth_user SET search_path = auth;

-- Hàm do app_owner (role chạy migration) tạo không mặc định cho PUBLIC quyền EXECUTE; hàm nào cần
-- dùng thì migration GRANT tường minh cho đúng role. Phải là default privilege toàn cục (không
-- IN SCHEMA): default theo schema chỉ cộng thêm quyền, không bỏ được EXECUTE mặc định của PUBLIC.
-- Không kèm IN SCHEMA nên áp cho cả public và auth.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER ROLE app_user  SET statement_timeout = :'user_stmt';
ALTER ROLE app_relay SET statement_timeout = :'relay_stmt';
ALTER ROLE auth_user SET statement_timeout = :'auth_stmt';
ALTER ROLE app_user  SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE app_relay SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE auth_user SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER DATABASE :"db" SET lc_messages TO 'C';
SQL
