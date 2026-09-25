#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_RELAY_PASSWORD:?required}"
: "${APP_USER_STATEMENT_TIMEOUT_MS:?required}" "${APP_RELAY_STATEMENT_TIMEOUT_MS:?required}" "${IDLE_IN_TX_TIMEOUT_MS:?required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v relay_pw="$APP_RELAY_PASSWORD" \
  -v user_stmt="${APP_USER_STATEMENT_TIMEOUT_MS}ms" -v relay_stmt="${APP_RELAY_STATEMENT_TIMEOUT_MS}ms" \
  -v idle_tx="${IDLE_IN_TX_TIMEOUT_MS}ms" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE app_relay LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_relay;
GRANT CREATE, USAGE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_relay;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE app_user  SET statement_timeout = :'user_stmt';
ALTER ROLE app_relay SET statement_timeout = :'relay_stmt';
ALTER ROLE app_user  SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE app_relay SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER DATABASE :"db" SET lc_messages TO 'C';
SQL
