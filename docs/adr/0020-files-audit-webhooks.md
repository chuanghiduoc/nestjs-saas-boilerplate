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

## Nền dùng chung (plan 6.0, 2026-09-29)

- Kill switch lưu trong bảng global `kill_switches` (BCNF, CHECK khoá/lý do, grant theo cột; không `DELETE`), đọc qua OpenFeature bằng `DbKillSwitchProvider`: snapshot trong bộ nhớ, làm mới mỗi `FLAGS_REFRESH_INTERVAL_MS` (mặc định 5 s), fail-static khi DB lỗi (`flags_refresh_failures_total`), lần nạp đầu lỗi → app không khởi động; `KillSwitches.isKilled` ném khi provider chưa sẵn sàng thay vì trả `false`. Khi tắt: `beforeApplicationShutdown` chỉ dừng làm mới (snapshot giữ, `isKilled` vẫn trả lời cho job/request còn dở dù thứ tự hook giữa module đổi), `onApplicationShutdown` mới bỏ client (từ đó `isKilled` ném). Mỗi app Nest một domain OpenFeature. `KillSwitches.set` là CAS theo `version` (`NO_ROW_VERSION = 0` khi chưa có dòng). Registry `defineKillSwitch` rỗng ở 6.0.
- `OrgMutationLock` (tenancy): khoá dòng org `FOR NO KEY UPDATE` trong transaction của caller cho 6A và 6C.
- `core/contracts/admin-readers.ts`: `FileUsageReader`, `WebhookStatsReader` (R-X16) — 6A/6C cài, 6D inject `@Optional()`.
- Hai role, `core/sweep`, `core/partitions`, body parser nhiều chủ, cờ event: ADR 0005, 0006, 0007 (mục "Cập nhật SP6 (6.0)").
