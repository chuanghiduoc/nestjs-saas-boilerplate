#!/usr/bin/env bash
# Chạy trong image Postgres (có openssl) lúc `compose up` của smoke: CA tạm + một chứng chỉ server cho
# mọi service hạ tầng. Luôn sinh mới (ghi đè): không bao giờ dùng lại chứng chỉ có thể đã hết hạn hay
# users.acl mang mật khẩu Redis của lần chạy trước.
set -euo pipefail
: "${REDIS_APP_USER:?required}" "${REDIS_PASSWORD:?required}"
cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=nsb-smoke-ca" -keyout ca.key -out ca.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=nsb-smoke" -keyout server.key -out server.csr
printf 'subjectAltName=DNS:postgres,DNS:pgbouncer,DNS:redis,DNS:mailpit,DNS:localhost,IP:127.0.0.1\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt
# Postgres chỉ nhận key thuộc chính nó và không cho group/other đọc.
install -o postgres -g postgres -m 0600 server.key pg-server.key
chmod 0644 ca.crt server.crt server.key
printf 'user default off\nuser %s on >%s ~* &* +@all\n' "$REDIS_APP_USER" "$REDIS_PASSWORD" > users.acl
chmod 0644 users.acl
rm -f ca.key ca.srl server.csr san.ext
