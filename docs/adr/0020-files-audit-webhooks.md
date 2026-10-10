# 0020 — Files, audit bền và webhook ra ngoài

- **Trạng thái:** đang triển khai theo các plan của SP6. Plan 6.0 (nền dùng chung) tạo file này và ghi kết quả spike P1–P3; phần Files (6A), Audit (6B), Webhooks (6C) do plan tương ứng viết (spec SP6 §18.5, R-X6).
- **Spec:** `docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md` (r2).

## Kết quả spike (plan 6.0)

Chạy trên nhánh của plan 6.0, hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis), database riêng không `OWNER` bootstrap bằng chính `01-roles.sh` (`test/support/scratch-db.ts`).

| # | Kết quả | Bằng chứng |
|---|---|---|
| P1 | Đạt. Hàm `SECURITY DEFINER SET search_path = ''` do `partition_owner` (NOLOGIN, `INHERIT FALSE`) sở hữu, `app_user` gọi, tạo partition bằng `CREATE TABLE … (LIKE cha INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` + `ATTACH PARTITION`: cha chỉ bị giữ `ShareUpdateExclusiveLock` (INSERT song song của `app_user` chạy trong lúc transaction bảo trì còn mở); `organizations` bị giữ `ShareRowExclusiveLock` (cùng `AccessShareLock`, `RowShareLock`) khi partition mới nhân bản FK — mode này chặn ghi vào `organizations` tới hết transaction bảo trì, nên transaction đó phải ngắn. Trigger dòng `BEFORE UPDATE OR DELETE` và index khai trên cha tự nhân bản sang partition; FK, identity của cha dùng được qua bảng cha. Partition không có RLS (`relrowsecurity = false`) nên không được có grant: `app_user` đọc thẳng partition → `42501`. `DETACH` + `DROP` hai tháng hết hạn xong trong 33 ms khi 5 INSERT song song, không lỗi. **`lock_timeout` là thuộc tính của hàm** (`… SET search_path = '' SET lock_timeout = '5s' AS $$`), không `PERFORM set_config('lock_timeout', '5s', true)` như chữ của spec §6.7 bước 3: `set_config(…, true)` trong thân sống tới hết transaction của caller (mọi migration sau trong lô `allOrNothing` sẽ chạy với 5 s thay cho `DB_MIGRATION_LOCK_TIMEOUT_MS`), còn biến của mệnh đề `SET` được khôi phục khi hàm thoát — đo: caller đặt `17s`, sau lời gọi vẫn `17s`. **Ngân sách của một lời gọi:** cả câu `SELECT … FROM <fn>_maintain(...)` chịu `statement_timeout` của phiên gọi: `app_user` trực tiếp (test, psql vận hành) = `DB_APP_STATEMENT_TIMEOUT_MS` (compose 5000, bằng `lock_timeout`, nên một hàm lo hai bảng với nhiều DETACH/DROP có thể nhận `57014` trước `55P03`); cron trên worker chạy trong `UnitOfWork.run` nên = `DB_WORKER_STATEMENT_TIMEOUT_MS` (mặc định 60 000); migration = `DB_MIGRATION_STATEMENT_TIMEOUT_MS`. Đo: 33 ms so với `statement_timeout` 5000 ms của `app_user`. 6C (hai bảng, drop `deliveries` rồi `messages`) phải so thời gian một lượt đo được với ngân sách này. Muốn sở hữu bảng có FK tới `organizations`, `partition_owner` cần `GRANT REFERENCES (id) ON organizations` (không có → `42501`); migration của 6C cấp grant này. | `test/integration/spike-sp6-0/partition-spikes.spec.ts` (không commit), PG 18, database riêng |
| P2 | Đạt. Hai bảng partitioned có FK `(org_id, message_id, created_at) → (org_id, id, created_at)`: `DETACH` + `DROP` partition con (deliveries) tháng M rồi mới tới partition cha (messages) tháng M chạy được; thứ tự ngược → `23503` (`removing partition "spike_msgs_p202606" violates foreign key constraint "spike_dels_org_id_message_id_created_at_fkey_1"`), không mất dòng. Hàm bảo trì của 6C phải drop `webhook_deliveries` trước `webhook_messages` cùng tháng. | như trên |
| P3 | Đạt. `@openfeature/server-sdk` 1.23.0 + peer `@openfeature/core` 1.12.0 nạp ESM dưới SWC/`nodenext`. Provider tự viết cài đủ bốn `resolve*Evaluation` (kiểu bắt buộc trả `Promise`; provider trả `Promise.resolve` từ snapshot trong bộ nhớ, không I/O). `OpenFeature.setProviderAndWait(domain, provider)` chạy `initialize` một lần; `initialize` reject → `setProviderAndWait` reject và client ở `ERROR`. Mỗi domain một provider độc lập (mỗi app Nest một domain). Thay provider của domain bằng `NOOP_PROVIDER` và `OpenFeature.close()` đều gọi `onClose`. Đánh giá kiểu khác boolean trên provider chỉ-boolean trả giá trị mặc định (SDK nuốt lỗi), nên `KillSwitches` chỉ hỏi boolean và tự kiểm `providerStatus`. | `test/unit/core/flags/openfeature-contract.spec.ts` (giữ làm test hợp đồng) |

**Luật cho bảng partitioned (R-X27, 2026-10-01):** bảng partitioned **không có FK tới `organizations`**.
- **Lý do:**
  - P1 chỉ đo khoá của `ATTACH`.
  - `DETACH` + `DROP` một partition mang FK tới `organizations` có thể giữ khoá mạnh trên `organizations` tới hết transaction bảo trì. Theo mã nguồn Postgres, `DROP TABLE` của bên tham chiếu cần khoá cả bảng được tham chiếu để gỡ trigger FK.
  - Hệ quả là mọi request đọc hoặc ghi org có thể khựng tới `lock_timeout` mỗi tháng.
- **Cách giữ ràng buộc:**
  - `org_id` của dòng partitioned vẫn được bảo vệ bằng RLS (`org_id = app_current_org()` trong `WITH CHECK`), và dòng chỉ được ghi trong `OrgScope` của org còn tồn tại.
  - Dòng của org đã purge hết hạn theo retention của chính bảng (audit/webhook giữ id trần, đúng C2).
  - Nếu cần dọn sớm thì dùng purge participant, không dùng FK.
- **Thứ được giữ:** FK **giữa hai bảng partitioned** của cùng một module (P2: `webhook_deliveries` → `webhook_messages`) không chạm `organizations` nên vẫn giữ.
- **Áp dụng:**
  - Luật "mọi bảng có `org_id` phải có FK tới `organizations`" của `rls-catalog.spec.ts` miễn cho bảng partitioned và partition của nó.
  - 6B/6C không cấp `GRANT REFERENCES (id) ON organizations` cho `partition_owner`.

## Kết quả spike (plan 6C)

| # | Kết quả | Bằng chứng |
|---|---|---|
| W1 | Đạt. `standardwebhooks` 1.1.1 (CommonJS) import được từ ESM (`import { Webhook, WebhookVerificationError }`); `sign(msgId, Date, body)` trả `v1,<base64>`, tất định; secret có hay không tiền tố `whsec_` cho cùng chữ ký; `verify` nhận header hai chữ ký cách dấu cách khi chỉ biết một secret, từ chối secret lạ, body đổi, timestamp lệch quá 300 s. | `test/unit/modules/integrations/standard-webhooks.contract.spec.ts` (được giữ) |
| W2 | Không đạt: oasdiff `v1.32.1` có so mục `webhooks` nhưng xếp việc bỏ `data/orgId` khỏi payload là `request-property-removed` mức WARN (với oasdiff, request body là thứ client gửi, nên bỏ trường không phá client; với webhook, ta là bên gửi và người nhận mới bị phá), thoát 0 dưới `--fail-on ERR`; cơ chế thay thế `test/unit/core/http/webhook-contract.spec.ts` (Task 16). Output nguyên văn: `1 changes: 0 error, 1 warning, 0 info` / `warning [request-property-removed] at` / `in API POST webhook:tenancy.org.updated@1` / ``removed the request property `data/orgId` `` / `exit=0`. Không nâng `request-property-removed` lên ERR trong `.oasdiff.yaml`: luật đó áp cả cho `paths`, nơi bỏ trường request là thay đổi tương thích. | lệnh của plan 6C Task 1 Step 4 (2026-10-10), image `tufin/oasdiff:v1.32.1` lấy từ `breaking/Dockerfile` (`action.yml` ghi `image: 'Dockerfile'`) của oasdiff-action commit `5e81b5c` |
| W3 | Không đạt cho FK (đo lúc review plan 6C): `DETACH` + `DROP` partition của bảng partitioned có FK tới một bảng thường lấy `AccessExclusiveLock` trên bảng được tham chiếu (SELECT song song bị chặn); `ATTACH` lấy `ShareRowExclusiveLock` (ghi bị chặn). Không FK thì bảng được tham chiếu không bao giờ bị khoá. Kết luận R-X33: không FK partitioned → bảng thường nóng; `webhook_deliveries` không FK tới `webhook_endpoints`; người ghi `FOR KEY SHARE OF e`, người xoá `NOT EXISTS` dưới `FOR UPDATE` của dòng endpoint; luật catalog trong `rls-catalog.spec.ts`. | phán quyết R-X33; plan 6C Task 1 Step 5 |

**AAD của secret ký webhook (review bảo mật 6C, M4, chấp nhận):** `webhook_endpoint_secrets:secret_enc:<orgId>:<secretPublicId>` không chứa id endpoint; theo spec §6.5. Chép một ciphertext sang endpoint khác cùng org vẫn giải mã được, nhưng việc đó đòi quyền ghi DB (`app_user` không có UPDATE trên `secret_enc`), nên không phải đường tấn công qua API.

## Webhooks (plan 6C, 2026-10-10)

- **Dữ liệu (S6-A27, S6-A29):** `webhook_event_types` (bảng tra cứu, FK RESTRICT), `webhook_endpoints`, `webhook_endpoint_secrets`
  (`FieldCipher`, AAD `webhook_endpoint_secrets:secret_enc:<orgId>:<publicId>`, tối đa một secret hiện hành, tối đa hai secret còn
  ký), `webhook_endpoint_event_types`, và hai bảng partitioned của `partition_owner`: `webhook_messages` (body tuần tự hoá một lần,
  ký nguyên văn) và `webhook_deliveries` (một dòng mỗi message × endpoint, `UNIQUE (org_id, message_id, created_at, endpoint_id)`).
  Bảng partitioned không FK tới `organizations` (R-X27) hay bảng thường nào (R-X33, spike W3: `DETACH` + `DROP` lấy
  `AccessExclusiveLock` trên bảng được tham chiếu): `webhook_deliveries` không FK tới `webhook_endpoints`; fan-out giữ dòng endpoint
  `FOR KEY SHARE`, sweep xoá cứng giữ `FOR UPDATE` rồi kiểm `NOT EXISTS` bằng câu riêng; test bất biến "mọi delivery có endpoint"
  (`orphanDeliveries`). `partition_owner` không có REFERENCES trên bảng thường nào.
- **Bảo trì partition:** `webhook_partitions_maintain` (lockKey 6002, sàn 1 tháng, drop deliveries trước messages cùng tháng, P2).
  Một lượt hai bảng đo được 22 ms, dưới `statement_timeout` 5 s của `app_user` (ngân sách P1).
- **Gửi (S6-A28, S6-A34):** Standard Webhooks (`webhook-id` = event id, `webhook-timestamp` giây Unix lúc gửi, chữ ký mọi secret còn
  hiệu lực cách dấu cách). Claim: khoá dòng endpoint, đếm in-flight, rồi CAS + lease + `attempts_total + 1`; job
  `webhook-<id>-a<n>` (n chưa từng claim), `-k<ms>` kiểm lại khi kill switch bật, `-b<ms>` khi endpoint đủ in-flight, `-s<slot>`
  cho sweep enqueue lại. Job tới sớm hơn `next_attempt_at` quá 1 s là no-op; dời (kill switch, bận) dùng
  `GREATEST(next_attempt_at, now + delay)` và chỉ khi đã đến hạn. Ghi kết quả là CAS có fencing
  `status = 'SENDING' AND attempts_total = n`; kết quả bị fence không chạm endpoint.
- **Phân loại (S6-A49, R-X35):** `classifyAttempt`; lỗi của ta (`BULKHEAD_FULL`, `CIRCUIT_OPEN`, `LEASE_EXPIRED`,
  `SECRET_UNAVAILABLE`, `DNS_UNAVAILABLE` — resolver của ta trả `EAI_AGAIN`/timeout, review bảo mật M7; `ENOTFOUND` vẫn là lỗi của endpoint) không tiêu lịch (`cycle_base + 1`), không chạm `failing_since`, nhưng có đếm (`local_failures`); lần thứ
  `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` (phát lại được, `retry`/`recover` đặt lại bộ đếm). Thành công xoá `failing_since`
  không tăng `version` (ETag của khách không đổi vì sức khoẻ); tự tắt (`AUTO_FAILING`) tăng `version` và phát
  `integrations.endpoint.disabled` đúng một lần (R6-12).
- **Bulkhead in-flight theo endpoint (R-X35):** claim khoá dòng endpoint `FOR NO KEY UPDATE` rồi đếm `SENDING` còn lease bằng câu
  riêng (snapshot mới); đủ `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` → từ chối (dời, không đếm). Rủi ro còn lại: trần là theo endpoint
  — một org có nhiều endpoint chết (tối đa `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG`) hay nhiều org cùng có endpoint chết vẫn chiếm được
  `N × số endpoint` slot; giảm nhẹ bằng trần endpoint mỗi org và tự tắt endpoint; trần theo org là việc sau (không phải 6C).
- **Bộ nhớ (M9):** mỗi request giữ tối đa `RESILIENCE_MAX_RESPONSE_BYTES` (mặc định 10 MB) của response, nhân bulkhead
  `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT` (mặc định 20): tệ nhất ~200 MB mỗi process worker chỉ cho body response webhook. Chấp nhận
  cho 6C; việc sau: trần response riêng cho provider `webhooks-out` (body response webhook không bao giờ được đọc).
- **Dead-letter (S6-A33):** tập `EXHAUSTED`/`CANCELLED` trong DB; `retry`, `recover` (lô `INTEGRATIONS_RECOVER_BATCH_MAX`), gửi thử
  `webhook.test`. Thứ tự khoá: API endpoint (`FOR SHARE`) → delivery kết thúc; fan-out endpoint (`FOR KEY SHARE`) → chèn delivery;
  claim endpoint (`FOR NO KEY UPDATE`) → delivery chưa gửi; ghi kết quả delivery `SENDING` → endpoint; sweep `SKIP LOCKED`. Ba tập
  delivery rời nhau nên không có chu trình (R6C-2).
- **Provider `webhooks-out` (S6-A30):** `retries: 0`, breaker không bao giờ mở, bulkhead ≥ concurrency của queue (luật
  `webhooks-bulkhead-covers-concurrency`). Một endpoint chậm (timeout 1000 ms) với 1000 delivery chờ, concurrency 20: endpoint khoẻ xong sau 6724 ms,
  SENDING của endpoint chậm tối đa 4 (W-46, cận tính được 85 000 ms; 24 lần TIMEOUT trong lúc đo). Luật
  `webhooks-timeout-below-lease` (review bảo mật I1): timeout thật của `webhooks-out`, kể cả `RESILIENCE_OVERRIDES`, phải nhỏ hơn
  `INTEGRATIONS_DELIVERY_LEASE_MS` trừ `WEBHOOK_LEASE_MARGIN_MS` (5 s), nếu không app không khởi động.
- **Catalog (R-X30):** code có mà DB thiếu → không khởi động; DB có mà code không biết → WARN + `webhook_event_types_unknown_to_code_total`.
- **OpenAPI (S6-A36):** mục `webhooks` của `openapi.json` (khoá `<type>@<version>`), so bằng `test/unit/core/http/webhook-contract.spec.ts` (W2 không đạt: oasdiff xếp bỏ trường payload là WARN) theo W2.
- **Purge:** participant `integrations` order 120, chỉ DB; trong rollout, worker cũ chưa có participant gặp `23001` và BullMQ retry.
- **DNS_UNAVAILABLE (M7) — rủi ro chấp nhận (review cuối):** `EAI_AGAIN` cũng là thứ `getaddrinfo` trả khi DNS của chính khách
  hỏng (SERVFAIL). Endpoint như vậy không bao giờ bị tự tắt; mỗi delivery tiêu `INTEGRATIONS_MAX_LOCAL_FAILURES` lần rồi `EXHAUSTED`
  (có trần, phát lại được), lỗi bị tính cho phía ta. Chấp nhận.
- **Telemetry (review cuối, I-A):** request webhook không có span client và không có điểm metric `http.client.request.duration` (URL và host của khách không vào OTel); provider khác mất query trong `url.full`. Chi tiết ở ADR 0014 "Cập nhật SP6 (6C)".
- **Review bảo mật (sau Task 12):** kill switch được kiểm lại ngay trước khi gửi; bật giữa claim và gửi thì claim được trả lại bằng
  CAS (`UNCLAIM`: `SENDING → RETRY_SCHEDULED`, `cycle_base + 1`, không đếm lỗi của ta) và không request nào ra ngoài (M1). Signal của
  job tới `HttpClient`: tắt worker huỷ request đang bay, delivery giữ lease cho sweep (M2). Xoay secret tăng `version` của endpoint
  (M3). Sweep xoá secret đã quá `expires_at` (M5; `integrations_orgs_due` cũng trả org có secret hết hạn).

## Nền dùng chung (plan 6.0, 2026-09-29)

- Kill switch lưu trong bảng global `kill_switches` (BCNF, CHECK khoá/lý do, grant theo cột; không `DELETE`), đọc qua OpenFeature bằng `DbKillSwitchProvider`: snapshot trong bộ nhớ, làm mới mỗi `FLAGS_REFRESH_INTERVAL_MS` (mặc định 5 s), fail-static khi DB lỗi (`flags_refresh_failures_total`), lần nạp đầu lỗi → app không khởi động; `KillSwitches.isKilled` ném khi provider chưa sẵn sàng thay vì trả `false`. Khi tắt: `beforeApplicationShutdown` chỉ dừng làm mới (snapshot giữ, `isKilled` vẫn trả lời cho job/request còn dở dù thứ tự hook giữa module đổi), `onApplicationShutdown` mới bỏ client (từ đó `isKilled` ném). Mỗi app Nest một domain OpenFeature. `KillSwitches.set` là CAS theo `version` (`NO_ROW_VERSION = 0` khi chưa có dòng). Registry `defineKillSwitch` rỗng ở 6.0.
- `OrgMutationLock` (tenancy): khoá dòng org `FOR NO KEY UPDATE` trong transaction của caller cho 6A và 6C.
- `core/contracts/admin-readers.ts`: `FileUsageReader`, `WebhookStatsReader` (R-X16) — 6A/6C cài, 6D inject `@Optional()`.
- Hai role, `core/sweep`, `core/partitions`, body parser nhiều chủ, cờ event: ADR 0005, 0006, 0007 (mục "Cập nhật SP6 (6.0)").
