#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_RELAY_PASSWORD:?required}" "${APP_AUTH_PASSWORD:?required}"
: "${APP_USER_STATEMENT_TIMEOUT_MS:?required}" "${APP_RELAY_STATEMENT_TIMEOUT_MS:?required}" "${AUTH_USER_STATEMENT_TIMEOUT_MS:?required}" "${IDLE_IN_TX_TIMEOUT_MS:?required}"
# DBA production chạy đúng script này (spec SP2 §5.3). Không dựa vào quyền mặc định của PUBLIC:
# PG 15+ chỉ bỏ CREATE trên schema public, vẫn để USAGE, CONNECT và TEMPORARY cho mọi role.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v relay_pw="$APP_RELAY_PASSWORD" -v auth_pw="$APP_AUTH_PASSWORD" \
  -v user_stmt="${APP_USER_STATEMENT_TIMEOUT_MS}ms" -v relay_stmt="${APP_RELAY_STATEMENT_TIMEOUT_MS}ms" -v auth_stmt="${AUTH_USER_STATEMENT_TIMEOUT_MS}ms" \
  -v idle_tx="${IDLE_IN_TX_TIMEOUT_MS}ms" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE app_relay LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE auth_user LOGIN PASSWORD :'auth_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;

REVOKE CONNECT, TEMPORARY ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_relay, auth_user;
-- Chỉ owner có bảng tạm (test catalog dùng bảng tạm để thử luật RLS).
GRANT TEMPORARY ON DATABASE :"db" TO app_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_relay;

-- Schema của Better Auth: tạo ở đây để app_owner không cần CREATE trên cả database; migration chỉ tạo/xoá bảng.
CREATE SCHEMA auth AUTHORIZATION app_owner;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO auth_user;
-- Cơ chế chọn schema của adapter bọc (spec §5.9): query không ghi schema không bao giờ rơi vào public.
ALTER ROLE auth_user SET search_path = auth;

ALTER ROLE app_user  SET statement_timeout = :'user_stmt';
ALTER ROLE app_relay SET statement_timeout = :'relay_stmt';
ALTER ROLE auth_user SET statement_timeout = :'auth_stmt';
ALTER ROLE app_user  SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE app_relay SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE auth_user SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER DATABASE :"db" SET lc_messages TO 'C';
SQL
