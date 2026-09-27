#!/bin/sh
# Entrypoint của edoburu/pgbouncer chỉ ghi DB_USER vào userlist. Thêm auth_user (mật khẩu thô; PgBouncer
# dùng nó để đăng nhập SCRAM tới Postgres) rồi chuyển cho entrypoint gốc (đã kiểm: /entrypoint.sh có
# hỗ trợ MAX_PREPARED_STATEMENTS và CLIENT_TLS_*/SERVER_TLS_*).
# Container restart giữ nguyên filesystem (userlist còn dòng cũ), nên chỉ ghi khi chưa có, giống cách
# entrypoint gốc kiểm DB_USER bằng grep; đổi mật khẩu thì compose tạo container mới.
set -eu
: "${AUTH_DB_PASSWORD:?required}"
AUTH_FILE_PATH=/etc/pgbouncer/userlist.txt
if ! grep -q '^"auth_user" ' "$AUTH_FILE_PATH" 2>/dev/null; then
  printf '"auth_user" "%s"\n' "$AUTH_DB_PASSWORD" >> "$AUTH_FILE_PATH"
fi
exec /entrypoint.sh "$@"
