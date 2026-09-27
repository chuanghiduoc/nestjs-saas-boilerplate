#!/bin/sh
# Entrypoint của edoburu/pgbouncer chỉ ghi DB_USER vào userlist. Thêm auth_user (mật khẩu thô; PgBouncer
# dùng nó để đăng nhập SCRAM tới Postgres) rồi chuyển cho entrypoint gốc (đã kiểm: /entrypoint.sh có
# hỗ trợ MAX_PREPARED_STATEMENTS và CLIENT_TLS_*/SERVER_TLS_*).
# Container restart giữ nguyên filesystem (userlist còn dòng cũ), nên chỉ ghi khi chưa có, giống cách
# entrypoint gốc kiểm DB_USER bằng grep; đổi mật khẩu thì compose tạo container mới.
set -eu
: "${AUTH_DB_PASSWORD:?required}"
: "${MAX_PREPARED_STATEMENTS:?required}"

# Entrypoint gốc bỏ qua biến rỗng và ghi nguyên 0; spike S2b (ADR 0010): 0 làm RateLimiterPostgres
# lỗi `prepared statement ... already exists`. Chỉ nhận số nguyên dương.
case "$MAX_PREPARED_STATEMENTS" in
  '' | *[!0-9]* | 0*)
    echo "MAX_PREPARED_STATEMENTS must be a positive integer" >&2
    exit 1
    ;;
esac

# Userlist bọc mật khẩu trong dấu ngoặc kép; dấu `"` hay ký tự điều khiển sẽ làm hỏng dòng.
# Không in mật khẩu ra log. grep xét từng dòng nên xuống dòng phải kiểm riêng.
fail_password() {
  echo 'AUTH_DB_PASSWORD must not contain " or control characters' >&2
  exit 1
}
newline='
'
case "$AUTH_DB_PASSWORD" in *"$newline"*) fail_password ;; esac
if printf '%s' "$AUTH_DB_PASSWORD" | LC_ALL=C grep -q '["[:cntrl:]]'; then
  fail_password
fi

# Cùng đường dẫn mặc định với entrypoint gốc (_AUTH_FILE).
AUTH_FILE_PATH="${AUTH_FILE:-/etc/pgbouncer/userlist.txt}"
if ! grep -q '^"auth_user" ' "$AUTH_FILE_PATH" 2>/dev/null; then
  printf '"auth_user" "%s"\n' "$AUTH_DB_PASSWORD" >> "$AUTH_FILE_PATH"
fi
exec /entrypoint.sh "$@"
