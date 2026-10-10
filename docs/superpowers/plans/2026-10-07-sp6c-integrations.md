# Sub-project 6C — Integrations: webhook ra ngoài — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm module `src/modules/integrations`: webhook ra ngoài cho khách theo Standard Webhooks. Gồm endpoint theo org, secret ký mã hoá bằng `FieldCipher` và xoay có chồng lấn (ký nhiều chữ ký), catalog event type (bảng tra cứu + kiểm lúc boot chịu được DB mới hơn code), fan-out từ bộ chọn `WEBHOOK_EVENTS` của core, gửi qua `HttpClient` chống SSRF (kiểm lúc đăng ký và lúc connect), retry theo lịch với `classifyAttempt` (lỗi của endpoint / lỗi của ta), dead-letter trong DB phát lại được (`retry`, `recover`), gửi thử, sweep qua `defineOrgSweep`, partition theo tháng qua `definePartitionedTable`, participant xoá cứng org (order 120), bản cài token `WebhookStatsReader`, kill switch `integrations.webhook_delivery`, mục `webhooks` của OpenAPI 3.1. Chứng minh trên Postgres 18 + PgBouncer + Redis thật và trên image production qua `docker compose --profile app` với `NODE_ENV=production`, receiver HTTPS trong network của compose; 6C ship một mình với CI xanh.

**Architecture:** Module theo mẫu tenancy/entitlements: `IntegrationsCoreModule` (`@Global`, api + worker) giữ repository SQL (`Db.execute` trên EM đang gắn), `UrlGuard`, `WebhookSigner`, `WebhookSecrets`, catalogue quyền và `WebhookEventCatalogueCheck`; `IntegrationsHttpModule` (chỉ api) giữ ba controller; `IntegrationsReadersModule` (`@Global`, chỉ api) cài `WebhookStatsReader` của `core/contracts`; `IntegrationsWorkerModule` (chỉ worker) giữ subscriber fan-out, handler gửi, handler sweep, participant purge và `WebhooksOutPolicy` (`setProviderDefaults('webhooks-out')`). Mọi lần gửi theo khuôn "claim bằng CAS trong transaction (lease + `attempts_total + 1`) → commit → ký + HTTP ngoài transaction → ghi kết quả bằng CAS có fencing `attempts_total`". Máy trạng thái thuần ở `domain/` (`switch` vét cạn có `never`); DB giữ bất biến bằng `CHECK`, FK kép, partial unique và `UNIQUE (org_id, message_id, created_at, endpoint_id)`. Hai bảng partitioned (`webhook_messages`, `webhook_deliveries`) thuộc `partition_owner`, không FK tới `organizations` (R-X27); hàm `integrations_orgs_due` thuộc `sweep_definer`.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), PostgreSQL 18, BullMQ qua `JobQueue`/`SafeEnqueue`/`WorkerHost`, `standardwebhooks` 1.1.1 (**package runtime mới duy nhất**; phụ thuộc `@stablelib/base64` ^1.0.0, `fast-sha256` ^1.3.0; đã kiểm `npm view` ngày 2026-10-07), undici qua `HttpClient` của core, cockatiel qua `ResiliencePolicies`, zod 4.6.5, uuid (`v7`), `@opentelemetry/api`, Vitest + Testcontainers, `test/support/tcp-proxy.ts`, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md` (r2, chốt 2026-09-29). Nguồn phạm vi: §17 Bảng 1 dòng "6C", Bảng 2 dòng "6C", Bảng 4, Bảng 5 cột "6C"; chi tiết ở §1 (tiêu chí 1, 10, 11, 13–16), §2.1, §3.1–3.2, §4 (W1), §5.1, §5.2, §5.3 (các hàng có 6C), §5.4 (luật 21, 25), §6.5, §6.7–§6.10, §7.2–§7.4, §8.3, §9, §10, §11.4, §12.1 T7/T8, §13, §14, §15, §16 W-*, X-2, X-3, X-4, X-6, X-7, X-9, §18.1, §18.5, §19.1 (S6-A26…A30, A33…A37, A46, A49, A52), §20. Phán quyết: `D:/backend-demo/.claude/worktrees/sp2-identity/.superpowers/autonomous/rulings.md` (R-X1…R-X35, bản hiệu lực; bản commit `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` dừng ở R-X27). Dòng chạm 6C: R-X3, R-X4, R-X5, R-X6, R-X7, R-X14, R-X16, R-X21, R-X24, R-X25, R-X27, R-X30, R-X33 (không FK từ bảng partitioned tới bảng thường nóng), R-X34 (đổi đích webhook = tạo mới), R-X35 (trần lỗi của ta + bulkhead in-flight theo endpoint). Addendum 3D `docs/superpowers/specs/2026-09-28-sp3-addendum-platform-staff.md` §A4 (registry order, `integrations = 120`). Mẫu định dạng và độ sâu: `docs/superpowers/plans/2026-10-05-sp4b-usage-quota-seats.md`, `docs/superpowers/plans/2026-10-01-sp3d-delegation.md`.

**Điều kiện bắt đầu (phụ thuộc thật, R-X7, spec §17 Bảng 0):** `origin/main` ở `bd6da1b` (merge PR #16, 4B usage/quota/seats) hoặc mới hơn; migration mới nhất của vùng boilerplate lúc viết plan là `entitlements/Migration20261005164759_usage_counters`. Tên đã đối chiếu với code khi viết plan:
- **6.0** (core): `defineEvent({ …, audit, webhook })`, `EventSubscriber({ consumer, events: WEBHOOK_EVENTS })`, `eventRegistry`, `findEvent`, `EventEnvelope`, `EventPublisher.publish(def, { data, aggregate, actor, causationId?, eventId? }, { ifAbsent? })` (ném khi event `webhook: true` phát ngoài org); `defineOrgSweep({ key, definerFunction, extraParams?, orgJob, jobIdPrefix, schedule, batch })` → `OrgSweepDef` (có `.job`), `OrgSweepRunner.run(def)`, `SweepModule`, `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START`, `sweepSignatureProblems` (`test/support/org-sweep-signatures.ts`); `definePartitionedTable({ tables, maintainFunction, lockKey, retentionMonths, premakeMonths })`, `partitionedTableRegistry`, `PartitionsModule`, `MaintainPartitionsHandler`; `defineKillSwitch({ key, description })`, `findKillSwitch`, `KillSwitches.isKilled/set/list`, `DbKillSwitchProvider.refreshOnce()`, `FlagsModule`, `NO_ROW_VERSION`; `WebhookStatsReader` (`src/core/contracts/admin-readers.ts`); `OrgMutationLock.lock(): Promise<boolean>` (tenancy index); role `partition_owner`, `sweep_definer`; `test/support/core-catalog.ts` (`SWEEP_DEFINER_FUNCTIONS`, `SWEEP_DEFINER_READ_TABLES`, `PARTITION_OWNER_FUNCTIONS`, `PARTITIONED_TABLES`, `OWNED_FUNCTIONS`, các hằng `_FIXTURE`); kết luận spike P1 (lock_timeout là thuộc tính hàm) và P2 (drop `deliveries` tháng M trước `messages` tháng M) ở ADR 0020; R-X27 (bảng partitioned không FK tới `organizations`).
- **7A**: `markModuleLoaded`, `loadedModules` (`core/config`), `BOILERPLATE_MODULES`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES`, `composeAppModules` (`src/boilerplate.modules.ts`), `BoilerplateModuleKey` (`src/boilerplate.module-keys.ts`), `test/support/composition-probe.ts`, `test/integration/composition/module-isolation.spec.ts` (UP-12c tự phủ mọi mục của `BOILERPLATE_MODULES`), `docs/boilerplate/README.md` (R-X25), `.upstream/zones.json` theo tiền tố.
- **3A–3D**: `definePermissionCatalogue`, `PermissionCatalogueContributor`, `OrgPurgeParticipant`, `OrgPurgeParticipantContributor({ key, order })`, `PurgeOrgHandler`, `OrgPurgeParticipantRegistry`, `SessionOnly`, `RequireFreshSession`, `RequireVerifiedEmail` (identity index), `startTenancyApp`, `authed`, `seedOrg`/`seedMember`/`withAppClient`/`inOrgTx`/`seedOrgApiKey`/`seedSupportGrant`/`apiKeyEligibleKeys`, `raceOnOrgLock` (`test/support/org-lock-barrier.ts`), `seedUserPrincipal`/`deleteSeededPrincipals`, `ownerQuery`, `tenancyCoreImports`.
- **Không cần** 6A, 6B, 4C, 7B. Hai điểm giao có bước riêng: **6A ∥ 6C** (spec §17 Bảng 4: plan merge sau mang dòng catalog của `files.file.ready`/`files.file.deleted`; Task 2 Step 6); **3D ∥ 6C** (3D đã merge, nên ca "org key không tạo được endpoint" thuộc 6C: Task 14).

**Không cần hai PR (R-X30, expand → contract):** 6C thêm dòng catalogue ở hai nơi. (1) `permissions` (`webhooks.*`): `CatalogueCheck` của tenancy đã chịu dòng chỉ có ở DB từ 3A (R-X21), nên pod cũ khởi động lại trên DB đã migrate vẫn boot. (2) `webhook_event_types`: bảng và `WebhookEventCatalogueCheck` cùng ra đời trong PR này; pod cũ không biết bảng; kiểm của 6C coi dòng chỉ có ở DB là WARN (Task 6), nên các plan thêm dòng sau (6A, SP5) không cần tách PR. Thứ tự deploy duy nhất: migrate Job chạy trước rollout (code có mà DB thiếu là lỗi boot, như mọi plan). Hệ quả có tên (ghi README, Task 19): trong lúc rollout, worker cũ (chưa có participant `integrations`) chạy purge một org đã có endpoint → `23001` to, BullMQ retry, worker mới purge được.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A–3D, 4A, 4B, 6.0 và 7A (mục Global Constraints của các plan đó), cộng các luật sau, bắt buộc cho mọi task:

- **Package-first:** chỉ cài `standardwebhooks` bằng `pnpm add standardwebhooks` (không ghi version; kỳ vọng `1.1.1`). Không cài `svix` (SDK dịch vụ trả phí), không import `ipaddr.js`/`undici`/`cockatiel` ngoài `core/resilience` (luật `outbound-libs-only-in-core-resilience`: dùng `assertUrlAllowed`, `isPublicAddress`, `parseCidrs`, `HttpClient`). Version khác `1.1.1` → dừng, đọc changelog, cập nhật spec §3.1, báo Sếp.
- **Generator:** migration sinh bằng `pnpm exec mikro-orm migration:create --blank --path src/migrations/integrations --name webhooks`; plan viết `Migration<ts>_webhooks`, code và test tìm theo hậu tố `_webhooks`, không viết cứng timestamp. Timestamp phải lớn hơn `20261005164759` và mọi migration của vùng boilerplate trên `main` lúc merge (`migration-order.spec.ts` kiểm; rebase không được dùng — merge `origin/main` rồi sinh lại nếu cần, Task 20).
- **Không đoán API:** mọi tên của core/tenancy/identity lấy từ code trên `main` (đối chiếu khi viết plan, liệt kê ở khối Interfaces). Tên lệch lúc thực thi → dùng tên thật, ghi vào báo cáo task. TDD; không `any`, không `as never`/`as any`, không tắt lint (`hardcode-scan.spec.ts`).
- **Standard Webhooks (spec §8.3, S6-A28):** header `webhook-id` = `event_id` của message; `webhook-timestamp` = giây Unix lúc gửi; `webhook-signature` = `secrets.map((s) => new Webhook(s).sign(eventId, ts, body)).join(' ')` với mọi secret còn hiệu lực (tối đa hai, secret hiện hành trước); secret = `whsec_` + base64 của `randomBytes(WEBHOOK_SECRET_BYTES = 32)`; body JSON `{ type, version, timestamp, data }` tuần tự hoá **một lần** lúc fan-out, lưu ở `webhook_messages.body`, ký nguyên văn ở mọi lần gửi; `user-agent: <APP_SERVICE_NAME>-webhooks/1`.
- **SSRF ở hai đầu (spec §8.3 bước 1, T7):** lúc tạo và lúc sửa URL, `UrlGuard.check` chạy **ngoài** transaction (DNS là I/O ngoài): `new URL`, cấm fragment, `assertUrlAllowed` (scheme/userinfo/port/IP literal), rồi `lookup(host, { all: true })` và **mọi** địa chỉ phải qua `isPublicAddress(ip, parseCidrs(RESILIENCE_SSRF_ALLOW_CIDRS))`; lỗi → `422 webhook_url_not_allowed`, detail chung, không nêu IP. Lúc gửi: chỉ `HttpClient.request('webhooks-out', …)` (`ssrfLookup` lúc connect chặn DNS rebinding, không theo redirect, `maxResponseSize`). Không module nào tự gọi `undici`/`fetch`.
- **Fencing và lease (spec §7.2, R6-9):** claim là CAS `PENDING | RETRY_SCHEDULED → SENDING` với `attempts_total + 1`, `lease_until = clock_timestamp() + INTEGRATIONS_DELIVERY_LEASE_MS`, chỉ khi `next_attempt_at <= clock_timestamp() + CLAIM_CLOCK_SKEW_MS` (job trùng hoặc tới sớm là no-op). Mọi CAS ghi kết quả có `status = 'SENDING' AND attempts_total = <số đã claim>`. `attempts_total` tăng ở **mọi** claim (kể cả nhánh `CANCELLED`), nên jobId `webhook-<id>-a<n>` không bao giờ bị dùng lại (BullMQ bỏ qua `add` trùng id của job còn giữ trong Redis).
- **Phân loại lỗi (spec §7.2, S6-A49, R6-28, R-X35):** `classifyAttempt(error): 'ENDPOINT' | 'LOCAL'`, `switch` vét cạn có `never`. `LOCAL` (`BULKHEAD_FULL`, `CIRCUIT_OPEN`, `LEASE_EXPIRED`, `SECRET_UNAVAILABLE`): không chạm endpoint, `cycle_base + 1` và `local_failures + 1` cùng CAS, hẹn lại sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` ± 10%; lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` (mặc định 5) → `EXHAUSTED` (phát lại được bằng `retry`/`recover`, hai lệnh này đặt lại `local_failures = 0`). `ENDPOINT`: tiêu một bước lịch, `failing_since = COALESCE(failing_since, clock_timestamp())`, có thể tự tắt endpoint (CAS `WHERE status = 'ACTIVE'`, R6-12); không đổi `local_failures`.
- **Bulkhead in-flight theo endpoint (R-X35):** claim khoá dòng endpoint `FOR NO KEY UPDATE`, đếm delivery `SENDING` của endpoint; đủ `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` (mặc định 4) → từ chối claim: hẹn lại `next_attempt_at` sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` ± 10%, **không** tăng `attempts_total`, **không** đếm vào `local_failures`, enqueue job mới (`webhook-<id>-a<n>-b<ms>`). Một endpoint chết không giữ quá N slot của bulkhead `webhooks-out` chung.
- **Thứ tự khoá (không deadlock):** đường API: `organizations` (chỉ create, qua `OrgMutationLock`) → dòng endpoint (`FOR NO KEY UPDATE` khi sửa/xoá/xoay; `FOR SHARE` khi retry/recover/test) → dòng delivery. Fan-out: dòng endpoint (`FOR KEY SHARE`, R-X33) → chèn delivery. Claim: dòng endpoint (`FOR NO KEY UPDATE`, bulkhead R-X35) → dòng delivery `PENDING | RETRY_SCHEDULED` (CAS). Ghi kết quả: dòng delivery `SENDING` (CAS) → dòng endpoint (UPDATE `failing_since`/tự tắt). Sweep: `SKIP LOCKED` trên mọi khoá dòng nên không bao giờ chờ. Chu trình đòi một transaction giữ delivery mà transaction kia cần; claim chỉ cần delivery chưa `SENDING`, ghi kết quả chỉ giữ delivery `SENDING`, API chỉ chạm delivery kết thúc — ba tập rời nhau, nên không có chu trình (CAS của claim bỏ qua dòng không khớp `WHERE` mà không chờ). Deadlock nếu có (`40P01`) được `UnitOfWork` retry, và mọi transaction của 6C chạy lại được (không I/O ngoài bên trong).
- **Mốc thời gian:** mọi cột ghi sau khi có thể đã chờ khoá dùng `clock_timestamp()` (bài học 3C); `created_at` dùng `DEFAULT now()`. `created_at` của delivery truyền qua app dưới dạng chuỗi ISO **micro giây** (`CREATED_AT_KEY`), không qua `Date` (mất micro giây làm CAS `created_at = ?` trượt).
- **Partition (spec §6.7, ADR 0020 P1/P2, R-X27):** hàm `public.webhook_partitions_maintain(p_retention_months integer, p_premake_months integer)` của `partition_owner`, `VOLATILE SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s'` (thuộc tính hàm, không bao giờ `set_config` trong thân), sàn retention 1 viết cứng, `pg_try_advisory_xact_lock(6002)`, mốc tháng UTC, drop `webhook_deliveries` tháng M trước `webhook_messages` tháng M. Bảng partitioned **không** có FK tới `organizations` (R-X27) **và không FK tới bảng thường nào** (R-X33, spike W3: `DETACH` + `DROP` lấy `AccessExclusiveLock` trên bảng được tham chiếu); chỉ giữ FK giữa hai bảng partitioned (`webhook_deliveries → webhook_messages`). `partition_owner` không nhận REFERENCES trên bảng thường nào. Bất biến "mọi delivery có endpoint": fan-out lấy `FOR KEY SHARE OF e` trước khi chèn; sweep xoá cứng lấy `FOR UPDATE` dòng endpoint rồi mới kiểm `NOT EXISTS` bằng câu riêng; test bất biến ở Task 3.
- **Sweep (R-X4, R-X14):** `public.integrations_orgs_due(p_after uuid, p_limit integer, p_grace_sec integer) RETURNS TABLE (org_id uuid)` của `sweep_definer`, `STABLE SECURITY DEFINER SET search_path = ''`, đúng một overload, trả org id tăng dần không trùng (runner kiểm). Khai bằng `defineOrgSweep({ key: 'integrations.sweep-orgs', definerFunction: 'integrations_orgs_due', extraParams: () => ({ p_grace_sec }), … })`.
- **Purge (R-X5, addendum 3D §A4):** `@OrgPurgeParticipantContributor({ key: 'integrations', order: 120 })` chỉ ở worker; chỉ DB, con trước cha: `webhook_deliveries`, `webhook_messages`, `webhook_endpoint_event_types`, `webhook_endpoint_secrets`, `webhook_endpoints`. Cùng mảng câu dùng cho `PURGE_ORDER` của `test/support/tenancy-seed.ts` (sau entitlements 100, trước tenancy 1000).
- **Cờ event (R-X3):** mọi event mới của 6C khai `audit: true, webhook: false` tường minh. 6C không đổi cờ của event module khác (sáu event tenancy đã `webhook: true` từ 6.0).
- **Kiểm catalog chịu được DB mới hơn code (R-X30, cùng luật R-X21):** type `webhook: true` trong code mà thiếu ở `webhook_event_types` → log ERROR `webhook_event_catalogue_mismatch`, không khởi động; dòng chỉ có ở DB → WARN một lần `webhook_event_types_unknown_to_code` + `webhook_event_types_unknown_to_code_total`, vẫn khởi động; dòng đó không đăng ký được (API chỉ nhận type code biết) và không bao giờ có fan-out.
- **Không hard code:** mọi giới hạn, lịch, thời hạn, cron, batch lấy từ `integrations.config.ts` (bảng env ở Task 5). Hằng định dạng có tên, dùng chung giữa zod và `CHECK`, test so hai phía (`constants-vs-migration.spec.ts`).
- **Truy cập SQL:** chỉ `Db.execute` (placeholder `?`, ép kiểu `?::uuid`, `?::bigint`, `?::timestamptz`); mảng bind là `ANY(ARRAY[?]::text[])`/`unnest(ARRAY[?]::uuid[])`; không import `@mikro-orm` ngoài `infra/`. Test đọc/ghi bảng FORCE RLS (`webhook_*` tenant) **bằng `app_user` trong OrgScope** (`withAppClient` + `inOrgTx`) và khẳng định `rowCount`; `ownerQuery` chỉ cho bảng global (`webhook_event_types`, `permissions`), `outbox_events` và catalog (FORCE RLS làm `ownerQuery` thấy 0 dòng mà không báo).
- **Problem+json:** trường lỗi nằm ở `errors` (option `fields` của `AppError`); type lạ ở `errors[] = { path: 'eventTypes', code: '<type>' }`.
- **Không PII (spec §15, X-7):** không URL endpoint (event chỉ mang `urlHost`), không body webhook, không secret, không chữ ký trong log/metric/span/event/failed reason; label metric là enum hữu hạn (`result`, `reason`), không `orgId`, không endpoint id; log chỉ mang public id (`endpointId`, `deliveryId`). Redact gốc thêm `webhookSecret`, `secretEnc`.
- **Race có tên và cơ chế:** R6-9…R6-15, R6-25, R6-26, R6-28 của spec, cộng R6C-1 (job trùng/tới sớm), R6C-2 (deadlock API ↔ gửi), R6C-3 (xoá cứng endpoint đua tạo delivery), R6C-4 (hai claim cùng endpoint vượt trần in-flight) của plan này (bảng ở Self-review mục 2). Check-then-insert không bao giờ là cơ chế. Race test ép xen kẽ bằng seam có sẵn: `raceOnOrgLock` cho R6-26; `raceOnRowLock` (mới, `test/support/integrations-races.ts`, cùng mẫu barrier `pg_blocking_pids`) cho R6-12/R6-14; receiver fixture có cửa (`hold()`/`release()`) cho R6-9/R6-11; không `sleep` may rủi.
- **Một test cho mỗi đăng ký constraint → lỗi:** `defineConstraintErrors` của 6C có test chứng minh đăng ký tồn tại (gọi lại cùng tên → ném "already mapped").
- **Luật kiến trúc (spec §5.4):** thêm luật 21 (`standardwebhooks` chỉ trong `src/modules/integrations/infra/**`) kèm fixture phải fail; luật 25 đã do `features-only-public-api` phủ, thêm fixture riêng cho integrations; luật 23 (`foundation-modules-independent-of-sp6`) đã có. Xoá ngoại lệ `no-orphans` của `src/core/contracts/admin-readers.ts` (6.0 ghi "plan đầu tiên import nó xoá ngoại lệ này"; nếu 6A đã xoá thì bỏ qua).
- **Nghĩa vụ SP7 (R-X16):** dòng đầu `src/modules/integrations/index.ts` gọi `markModuleLoaded('integrations')`; khoá `integrations` trong `BoilerplateModuleKey`, mục `integrations` trong `BOILERPLATE_MODULES` (sau mục cuối hiện có), `integrations: ['tenancy']` trong `MODULE_REQUIRES`. 6C không có env bí mật (secret ký trong DB, mã hoá bằng khoá `FieldCipher` sẵn có), nên không có `.meta({ secret })` (R-X20: `.meta` là việc của 7B cho secret thật). Không import config nào vào `gen-env-example.ts` (R-X25).
- **Zone:** mọi file mới nằm dưới tiền tố đã phân vùng `boilerplate` của `.upstream/zones.json` (`src/modules/`, `src/migrations/`, `src/core/`, `test/`, `docs/adr/`, `docs/boilerplate/`, `docs/superpowers/`); `node tools/upstream/check.mjs --self` xanh mà không sửa `zones.json`.
- **README:** mọi thay đổi README vào `docs/boilerplate/README.md` (R-X25). `.env.example` chỉ sinh lại bằng `pnpm env:example`.
- **OpenAPI:** task nào đổi bề mặt HTTP sinh lại `openapi.json` bằng `pnpm build && pnpm openapi:export` và commit cùng task; `oasdiff` chỉ được thấy thay đổi cộng thêm.
- **CodeQL:** `.github/codeql/accepted-findings.txt` khớp `rule path:line`; 6C không sửa file nào có trong danh sách (hôm nay chỉ `src/modules/tenancy/domain/acquisition-token.ts:8`). Finding mới (vd. `js/request-forgery` trên `HttpClient.request` của handler gửi) → kiểm tay, sửa code nếu thật; chỉ khi là false positive đã kiểm tay mới thêm dòng `rule path:line` kèm lý do (Task 20).
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** Task 18 và Task 20 chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app`, `NODE_ENV=production`, TLS mọi nơi, migrate từ `dist`, smoke HTTP/psql, receiver HTTPS trong network compose, log JSON sạch, `/health/ready` 200, `down -v`. Kích thước image ghi ở ADR 0013 (dòng "SP6 (6C)").
- **Spike:** code spike (W2) ở thư mục tạm, **không commit**, trừ phần ghi "được giữ" (W1); W3 là kết quả đã đo (R-X33), không có code; kết quả vào ADR 0020 mục "Kết quả spike (plan 6C)" và được commit.
- **Git:** chỉ commit mới; không amend, không rebase, không force; không push, không mở PR (Task 20 dừng ở "sẵn sàng cho PR"). Trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`; conventional message tiếng Anh.

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không mã test nào của spec §16 phủ, dễ làm hỏng người dùng nhất:

1. **Host viết bằng số, rút gọn hoặc có dấu chấm cuối** trỏ về loopback/private: `https://2130706433/`, `https://0x7f.1/`, `https://127.1/`, `https://[0:0:0:0:0:ffff:7f00:1]/`, `https://LOCALHOST./`. Bộ parse WHATWG chuẩn hoá bốn dạng đầu thành IP literal; dạng cuối là tên miền phân giải ra `127.0.0.1`. Mong đợi: mọi dạng → `422 webhook_url_not_allowed`, không bao giờ `201`. Test: Task 7 (`Review Focus 1: numeric, shortened and trailing-dot hosts are refused`).
2. **Tên miền phân giải ra nhiều địa chỉ, chỉ một là private** (multi-A, hoặc AAAA `::1` cạnh A công khai): kiểm "địa chỉ đầu" sẽ lọt. Mong đợi: bất kỳ địa chỉ nào không công khai → `422`; tập rỗng → `422`. Test: Task 7 (`Review Focus 2: one private address among public ones is refused`).
3. **`Retry-After` bất thường trên 429:** thiếu header; HTTP-date đã qua (`0`); giá trị vượt `RESILIENCE_RETRY_AFTER_MAX_SEC` (HttpClient đã chặn trần). Mong đợi: thiếu hoặc `0` → theo lịch có jitter; lớn → đúng trần; không bao giờ ngắn hơn bước lịch, không bao giờ bỏ lịch. Test: Task 4 (`retryDelayMs`) và Task 11 (`Review Focus 3: 429 Retry-After is a floor, capped by HttpClient`).
4. **Xoay secret hai lần liên tiếp trong thời gian chồng lấn.** Mong đợi: sau lần hai, đúng hai secret còn ký (mới nhất và ngay trước nó); secret đầu hết hạn ngay (`expires_at = now`) và bị xoá ở lần xoay kế; header chữ ký có đúng hai chữ ký; secret đầu không verify được nữa. Test: Task 9 (`Review Focus 4: rotating twice within the overlap keeps exactly two signing secrets`).
5. **Cursor danh sách delivery bị sửa tay:** base64 hỏng; JSON không phải mảng hai phần tử; mốc không phải ISO micro giây; id không phải UUID; cursor của endpoint khác. Mong đợi: `400 invalid_cursor` với mọi dạng hỏng, không bao giờ `500`; cursor của endpoint khác chỉ trả dữ liệu của endpoint trong path. Test: Task 14 (`Review Focus 5: a tampered cursor is 400 invalid_cursor, never 500`).

---

## File Structure

```
src/
  boilerplate.module-keys.ts        + 'integrations'
  boilerplate.modules.ts            + mục integrations, MODULE_REQUIRES integrations → tenancy
  core/http/openapi.ts              + mục `webhooks` (OpenAPI 3.1) cho mọi event `webhook: true` (S6-A36)
  core/logging/redaction.ts         + webhookSecret, secretEnc
  migrations/integrations/Migration<ts>_webhooks.ts
  modules/integrations/
    index.ts (dòng đầu markModuleLoaded) · integrations.module.ts · integrations.config.ts · constants.ts · errors.ts
    events.ts · jobs.ts · kill-switches.ts · partitions.ts · permissions.ts · integrations-telemetry.ts
    domain/        webhook-delivery.ts (máy trạng thái + classifyAttempt) · retry-schedule.ts · webhook-endpoint.ts
                   webhook-payload.ts · attempt-outcome.ts
    application/   actor.ts · event-catalogue-check.ts · integrations-metrics.ts · webhook-secrets.ts · endpoint.service.ts
                   fanout.subscriber.ts · deliver-webhook.handler.ts · local-failures.ts · webhooks-out-policy.ts · delivery.service.ts
                   sweep.handlers.ts · integrations-purge.participant.ts · webhook-stats.reader.ts
    ports/         url-guard.ts · webhook-signer.ts · endpoint-repository.ts · delivery-repository.ts
    http/          schemas.ts · delivery-cursor.ts · webhook-endpoints.controller.ts · webhook-deliveries.controller.ts
                   event-types.controller.ts
    infra/         dns-url-guard.ts · standard-webhooks.signer.ts
                   sql/created-at-key.ts · sql/sql-endpoint.repository.ts · sql/sql-delivery.repository.ts
                   sql/integrations-purge.sql.ts
.dependency-cruiser.cjs              luật 21; bỏ ngoại lệ no-orphans của core/contracts/admin-readers.ts
test/
  support/  core-catalog.ts (+ hằng _6C) · tenancy-seed.ts (PURGE_ORDER + integrations) · integrations-seed.ts
            integrations-app.ts · webhook-receiver.ts · integrations-races.ts · composition-disable-probe.ts
  architecture/fixtures/src/        fixture phải fail của luật 21 và luật 25 cho integrations
  unit/     modules/integrations/*.spec.ts · architecture/rules.spec.ts · composition/compose.spec.ts
            core/logging/redaction.spec.ts · core/http/openapi-webhooks.spec.ts
  integration/ integrations/*.spec.ts · core/database/{rls-catalog,normalization-inventory}.spec.ts
            composition/disable-integrations.spec.ts
  e2e/integrations/*.e2e.spec.ts
  chaos/integrations-outages.spec.ts · chaos/integrations-worker-kill.spec.ts
  smoke/integrations.smoke.spec.ts · smoke/webhook-receiver.mjs · smoke/compose.smoke.yaml · smoke/gen-certs.sh
        smoke/smoke-app-env.ts
docs/adr/ 0020 (phần Webhooks, spike 6C) · 0006 · 0013 · 0016 · 0005
docs/boilerplate/README.md (mục "Webhook ra ngoài")
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (§6, §14) · 2026-09-28-sp3-tenancy-access-design.md (§23.2)
openapi.json · .env.example (sinh lại)
```

**Vì sao `IntegrationsCoreModule` là module tĩnh `@Global`:** test e2e cần cả api lẫn worker trong một process (một `DatabaseModule` mỗi process). `forApi()` và `forWorker()` cùng import module tĩnh này nên Nest chỉ dựng một instance, như `TenancyCoreModule`. Controller chỉ ở `IntegrationsHttpModule`; handler, subscriber, participant, policy chỉ ở `IntegrationsWorkerModule`.

**Vì sao `WebhooksOutPolicy` chỉ ở worker:** `ResiliencePolicies.setProviderDefaults` ném khi gọi hai lần hoặc sau lời gọi đầu tới provider. Chỉ worker gọi `HttpClient` với `webhooks-out`; api chỉ kiểm URL bằng `UrlGuard`, không gửi gì.

**Vì sao thêm `INTEGRATIONS_PARTITION_PREMAKE_MONTHS`:** `definePartitionedTable` đòi `premakeMonths: () => number`. Spec §11.4 không liệt kê env này, nhưng viết cứng số tháng trái luật "không hard code". Mặc định `3`, khoảng `1–12`, cùng giá trị với `AUDIT_PARTITION_PREMAKE_MONTHS` của 6B.

**Vì sao `domain/attempt-outcome.ts` tách khỏi handler:** ánh xạ "kết quả của `HttpClient` → `last_error`" (spec §8.3 bước 4) là hàm thuần có `switch` vét cạn trên `UpstreamFailure`; đặt riêng để unit test phủ mọi nhánh mà không cần mạng.

---

## Phần A — Spike, package, luật kiến trúc (spec §4 W1)

### Task 1: Kiểm tiền điều kiện; cài `standardwebhooks`; spike W1 giữ thành test hợp đồng; spike W2 (oasdiff trên mục `webhooks`); ghi kết quả đã đo của W3 (khoá của FK partitioned → `webhook_endpoints`, R-X33); luật kiến trúc 21 và 25

**Files:**
- Create (được giữ): `test/unit/modules/integrations/standard-webhooks.contract.spec.ts`, `test/architecture/fixtures/src/modules/billing/infra/uses-standardwebhooks.ts`, `test/architecture/fixtures/src/modules/integrations/infra/standardwebhooks-ok.ts`, `test/architecture/fixtures/src/modules/integrations/index.ts`, `test/architecture/fixtures/src/modules/integrations/application/internal.ts`, `test/architecture/fixtures/src/features/x/uses-integrations-internals.ts`
- Modify (được giữ): `package.json`, `pnpm-lock.yaml`, `renovate.json`, `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`, `docs/adr/0020-files-audit-webhooks.md`
- Throwaway: thư mục tạm `$TMPDIR/sp6c-oasdiff/`

**Interfaces:**
- Consumes: ADR 0020 (mục "Kết quả spike (plan 6.0)", luật R-X27); `.dependency-cruiser.cjs` (luật 1–20.8 + 22, 23, 27); `test/unit/architecture/rules.spec.ts` (bảng `it.each` của rule → fixture); `ownerQuery` (`test/support/identity-app.ts`), `withAppClient`/`inOrgTx`/`seedOrg` (`test/support/tenancy-seed.ts`), `getInfra` (`test/support/infra.ts`).
- Produces:
  - dependency `standardwebhooks` 1.1.1;
  - hợp đồng mà Task 7 (`StandardWebhooksSigner`) và test phía người nhận (Task 11, Task 18) dựa vào, mỗi điều một ca test: import ESM được `Webhook`, `WebhookVerificationError`; `sign(msgId, Date, body)` trả `v1,<base64>` và tất định; có hay không tiền tố `whsec_` cho cùng chữ ký; `verify` nhận header hai chữ ký cách dấu cách khi chỉ biết một secret; `verify` từ chối timestamp lệch quá 300 s và body đổi;
  - luật depcruise `standardwebhooks-only-in-integrations-infra` (21);
  - dòng W1, W2, W3 trong mục "Kết quả spike (plan 6C)" của ADR 0020; kết luận W2 chọn nhánh của Task 16; W3 là kết quả đã đo lúc review plan (không phải cổng): không FK `webhook_deliveries → webhook_endpoints` (R-X33).

- [ ] **Step 1: Kiểm tiền điều kiện (dừng nếu thiếu)**

Run:
```bash
git fetch origin
git log --oneline -1 origin/main
git merge-base --is-ancestor bd6da1b origin/main && echo "main has 4B (bd6da1b)" || echo "main lacks bd6da1b"
ls src/migrations/entitlements | grep -c "_usage_counters.ts"
grep -n "export function defineOrgSweep\|export function definePartitionedTable\|export function defineKillSwitch" -r src/core
grep -n "WEBHOOK_EVENTS" src/core/events/index.ts
grep -n "OrgMutationLock" src/modules/tenancy/index.ts
grep -n "markModuleLoaded\|loadedModules" src/core/config/index.ts
grep -n "WebhookStatsReader" src/core/contracts/admin-readers.ts
grep -n "MODULE_REQUIRES\|OPTIONAL_BRIDGES" src/boilerplate.modules.ts | head -3
grep -n "partition_owner\|sweep_definer" docker/postgres/init/01-roles.sh | head -4
test -f src/modules/files/events.ts && grep -n "webhook: true" src/modules/files/events.ts || echo "6A not merged"
test -d src/modules/integrations && echo "STOP: integrations already exists" || echo "integrations absent"
```
Expected: "main has 4B (bd6da1b)", `1`, mỗi grep in ra ít nhất một dòng, "integrations absent". "main lacks bd6da1b" hoặc thiếu tên nào của 6.0/7A → **dừng**, báo controller. Ghi vào báo cáo task dòng của `src/modules/files/events.ts`: "6A not merged" hoặc danh sách event `files.*` có `webhook: true` (quyết định nhánh của Task 2 Step 6).

- [ ] **Step 2: Cài package**

Run:
```bash
pnpm view standardwebhooks@latest version dependencies
pnpm add standardwebhooks
grep -n '"standardwebhooks"' package.json
```
Expected: version `1.1.1`, dependencies `@stablelib/base64`, `fast-sha256`; `package.json` có `"standardwebhooks": "1.1.1"` (repo ghi version chính xác). Khác `1.1.1` → dừng (Global Constraints).

`renovate.json`: thêm vào mảng `packageRules`, cạnh nhóm của `openfeature` (6.0), cùng hình dạng:
```json
{ "groupName": "standardwebhooks", "matchPackageNames": ["standardwebhooks"] }
```

- [ ] **Step 3: Test hợp đồng W1 (viết trước; được giữ)**

`test/unit/modules/integrations/standard-webhooks.contract.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';

/**
 * Spike W1 (spec SP6 §4) giữ thành test hợp đồng: đúng những gì `StandardWebhooksSigner` (Task 7) và test phía người nhận
 * (Task 11, smoke Task 18) dựa vào. `standardwebhooks` 1.1.1 là CommonJS; Node nạp named export qua cjs-module-lexer.
 */
const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const SIGNATURE = /^v1,[A-Za-z0-9+/]+={0,2}$/;
/** Dung sai timestamp cố định của thư viện (`WEBHOOK_TOLERANCE_IN_SECONDS` trong dist/index.js). */
const TOLERANCE_SEC = 5 * 60;
const headersOf = (id: string, at: Date, signature: string) => ({
  'webhook-id': id,
  'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
  'webhook-signature': signature,
});

describe('standardwebhooks 1.1.1 contract (spike W1)', () => {
  it('imports Webhook and WebhookVerificationError from ESM', () => {
    expect(typeof Webhook).toBe('function');
    expect(new WebhookVerificationError('x')).toBeInstanceOf(Error);
  });
  it('sign(msgId, Date, body) is v1,<base64>, deterministic, and accepts the whsec_ prefix or not', () => {
    const s = secret();
    const at = new Date();
    const a = new Webhook(s).sign('evt_1', at, '{"a":1}');
    expect(a).toMatch(SIGNATURE);
    expect(new Webhook(s).sign('evt_1', at, '{"a":1}')).toBe(a);
    expect(new Webhook(s.slice('whsec_'.length)).sign('evt_1', at, '{"a":1}')).toBe(a);
  });
  it('verify accepts two space-separated signatures when it knows only one of the two secrets', () => {
    const [oldS, newS] = [secret(), secret()];
    const at = new Date();
    const body = JSON.stringify({ type: 'tenancy.org.updated', version: 1, timestamp: at.toISOString(), data: { k: 1 } });
    const headers = headersOf('evt_2', at, [newS, oldS].map((s) => new Webhook(s).sign('evt_2', at, body)).join(' '));
    expect(new Webhook(oldS).verify(body, headers)).toEqual(JSON.parse(body));
    expect(new Webhook(newS).verify(body, headers)).toEqual(JSON.parse(body));
    expect(() => new Webhook(secret()).verify(body, headers)).toThrow(WebhookVerificationError);
  });
  it('verify refuses a timestamp outside the tolerance and a changed body', () => {
    const s = secret();
    const old = new Date(Date.now() - (TOLERANCE_SEC + 60) * 1000);
    expect(() => new Webhook(s).verify('{}', headersOf('evt_3', old, new Webhook(s).sign('evt_3', old, '{}')))).toThrow(/too old/);
    const now = new Date();
    expect(() => new Webhook(s).verify('{"x":1}', headersOf('evt_3', now, new Webhook(s).sign('evt_3', now, '{}')))).toThrow(
      /No matching signature/,
    );
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/integrations/standard-webhooks.contract.spec.ts`
Expected: chạy trước Step 2 → FAIL `Cannot find package 'standardwebhooks'`; sau Step 2 → PASS. Ghi cả hai lần chạy vào báo cáo task. Ca nào đỏ sau khi cài → W1 không đạt: fallback spec §4 (HMAC-SHA256 chuẩn tự ký bằng `node:crypto`, vẫn dùng package cho `verify` trong test); ghi ADR, báo Sếp trước Task 7.

- [ ] **Step 4: Spike W2 — oasdiff có báo breaking change trong mục `webhooks` của OpenAPI 3.1 không (throwaway)**

S6-A36 dựa vào `oasdiff` của CI (`oasdiff/oasdiff-action/breaking@5e81b5c…` v0.1.17, `.github/workflows/ci.yml:47`). Chưa ai kiểm oasdiff có so mục `webhooks`.

Run:
```bash
gh api "repos/oasdiff/oasdiff-action/contents/breaking/action.yml?ref=5e81b5c380accc6b523f9d32a637ca630e33620b" --jq .content | base64 -d | grep -n "image"
```
Expected: một dòng `image: docker://tufin/oasdiff:<tag>` (hoặc tương tự). Gọi `<IMAGE>` là giá trị đó bỏ tiền tố `docker://` (dữ liệu đo, không phải chỗ trống của plan).

Run:
```bash
mkdir -p "$TMPDIR/sp6c-oasdiff"
node -e '
const base = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {},
  webhooks: { "tenancy.org.updated@1": { post: { requestBody: { required: true, content: { "application/json": { schema: {
    type: "object", required: ["type","version","timestamp","data"],
    properties: { type: { const: "tenancy.org.updated" }, version: { const: 1 }, timestamp: { type: "string" },
      data: { type: "object", required: ["orgId"], properties: { orgId: { type: "string" } } } } } } } },
    responses: { "200": { description: "ok" } } } } } };
const rev = JSON.parse(JSON.stringify(base));
const d = rev.webhooks["tenancy.org.updated@1"].post.requestBody.content["application/json"].schema.properties.data;
d.properties = {}; d.required = [];
const fs = require("fs");
fs.writeFileSync(process.env.TMPDIR + "/sp6c-oasdiff/base.json", JSON.stringify(base));
fs.writeFileSync(process.env.TMPDIR + "/sp6c-oasdiff/rev.json", JSON.stringify(rev));'
docker run --rm -v "$TMPDIR/sp6c-oasdiff:/s:ro" <IMAGE> breaking /s/base.json /s/rev.json --fail-on ERR; echo "exit=$?"
rm -r "$TMPDIR/sp6c-oasdiff"
```
Expected: ghi **nguyên output** vào ADR (Step 7); đúng một trong hai:
- **(a) Đạt:** oasdiff in một thay đổi breaking ở webhook `tenancy.org.updated@1` và `exit=1` → Task 16 dùng nhánh "oasdiff".
- **(b) Không đạt:** im lặng hoặc `exit=0` → Task 16 dùng nhánh fallback (`test/unit/core/http/webhook-contract.spec.ts` so mục `webhooks` của `openapi.json` với `origin/main:openapi.json`); ghi ADR, báo controller (S6-A36 đổi cơ chế, giữ bảo đảm).

- [ ] **Step 5: Spike W3 — kết quả đã đo (ghi lại, không chạy lại, không phải cổng)**

Câu hỏi của W3: FK `webhook_deliveries → webhook_endpoints(org_id, id)` có cùng hệ quả khoá như FK partitioned → `organizations` mà R-X27 cấm không. Đã đo lúc review plan 6C (Postgres 18, bảng thường `spike_eps` + bảng partitioned `spike_dels` có FK `ON DELETE RESTRICT`, owner `partition_owner`):
- `ALTER TABLE … DETACH PARTITION` + `DROP TABLE` partition lấy **`AccessExclusiveLock` trên bảng được tham chiếu**, giữ tới hết transaction: `SELECT` song song trên bảng đó **bị chặn** (fan-out, claim, mọi API đọc endpoint đứng chờ mỗi lượt bảo trì hằng tháng).
- `ATTACH PARTITION` (premake) lấy `ShareRowExclusiveLock` trên bảng được tham chiếu: ghi song song bị chặn.
- Không có FK → hai câu trên không bao giờ khoá `webhook_endpoints`.

Kết luận (R-X33, áp cho mọi bảng partitioned của boilerplate): không FK từ bảng partitioned (hay partition) tới bảng thường nóng. Người ghi lấy `FOR KEY SHARE` trên dòng cha; người xoá kiểm `EXISTS` dưới khoá dòng cha; có test bất biến. 6C áp: Task 2 (không FK, không REFERENCES, ca catalog R-X33), Task 3 (test bất biến), Task 10 (`FOR KEY SHARE OF e`), Task 11 (sweep xoá cứng). Bước này chỉ ghi dòng W3 vào ADR ở Step 7; không có file spike.
- [ ] **Step 6: Luật kiến trúc 21 và fixture của luật 25 (viết test trước)**

`test/unit/architecture/rules.spec.ts`: thêm vào bảng `it.each` (sau dòng `tenancy-test-hooks-only-in-tenancy`):
```ts
    [
      'standardwebhooks-only-in-integrations-infra',
      'modules/billing/infra/uses-standardwebhooks.ts',
    ],
    ['features-only-public-api', 'features/x/uses-integrations-internals.ts'],
```
Fixture:
- `test/architecture/fixtures/src/modules/billing/infra/uses-standardwebhooks.ts`:
```ts
import { Webhook } from 'standardwebhooks';
export const leak = Webhook;
```
- `test/architecture/fixtures/src/modules/integrations/infra/standardwebhooks-ok.ts` (đường được phép; tên kết thúc `ok.ts` nên ca "allows public APIs…" khẳng định không vi phạm):
```ts
import { Webhook } from 'standardwebhooks';
export const allowed = Webhook;
```
- `test/architecture/fixtures/src/modules/integrations/application/internal.ts`:
```ts
export const internal = 1;
```
- `test/architecture/fixtures/src/modules/integrations/index.ts`:
```ts
export { internal } from './application/internal.js';
```
- `test/architecture/fixtures/src/features/x/uses-integrations-internals.ts`:
```ts
import { internal } from '../../modules/integrations/application/internal.js';
export const leak = internal;
```
Run: `pnpm vitest run --project unit test/unit/architecture/rules.spec.ts`
Expected: FAIL ở ca `standardwebhooks-only-in-integrations-infra catches …` (luật chưa có). Ca `features-only-public-api catches …uses-integrations-internals.ts` PASS ngay: luật có sẵn phủ luật 25 của spec §5.4; fixture này là bằng chứng riêng cho integrations.

`.dependency-cruiser.cjs`: thêm sau luật `tenancy-test-hooks-only-in-tenancy`:
```js
    {
      name: 'standardwebhooks-only-in-integrations-infra',
      severity: 'error',
      comment:
        'SP6 rule 21: Standard Webhooks signing lives behind the WebhookSigner port in integrations infra only.',
      from: { pathNot: '(^|/)src/modules/integrations/infra/' },
      to: { path: 'node_modules/standardwebhooks/' },
    },
```
Run:
```bash
pnpm vitest run --project unit test/unit/architecture/rules.spec.ts
pnpm arch
```
Expected: PASS; `pnpm arch` sạch (cây `src` chưa import `standardwebhooks`).

- [ ] **Step 7: Ghi ADR 0020**

`docs/adr/0020-files-audit-webhooks.md`: thêm mục ngay sau khối "Luật cho bảng partitioned (R-X27, …)":
```markdown
## Kết quả spike (plan 6C)

| # | Kết quả | Bằng chứng |
|---|---|---|
| W1 | Đạt. `standardwebhooks` 1.1.1 (CommonJS) import được từ ESM (`import { Webhook, WebhookVerificationError }`); `sign(msgId, Date, body)` trả `v1,<base64>`, tất định; secret có hay không tiền tố `whsec_` cho cùng chữ ký; `verify` nhận header hai chữ ký cách dấu cách khi chỉ biết một secret, từ chối secret lạ, body đổi, timestamp lệch quá 300 s. | `test/unit/modules/integrations/standard-webhooks.contract.spec.ts` (được giữ) |
| W2 | (ghi đúng một câu theo output thật của Step 4: (a) "Đạt: oasdiff `<tag>` báo `<id>` ở `webhooks/tenancy.org.updated@1`, thoát 1" hoặc (b) "Không đạt: oasdiff `<tag>` không so mục `webhooks` (thoát 0); cơ chế thay thế `test/unit/core/http/webhook-contract.spec.ts` (Task 16)") | lệnh của plan 6C Task 1 Step 4, image lấy từ `action.yml` của oasdiff-action commit `5e81b5c` |
| W3 | Không đạt cho FK (đo lúc review plan 6C): `DETACH` + `DROP` partition của bảng partitioned có FK tới một bảng thường lấy `AccessExclusiveLock` trên bảng được tham chiếu (SELECT song song bị chặn); `ATTACH` lấy `ShareRowExclusiveLock` (ghi bị chặn). Không FK thì bảng được tham chiếu không bao giờ bị khoá. Kết luận R-X33: không FK partitioned → bảng thường nóng; `webhook_deliveries` không FK tới `webhook_endpoints`; người ghi `FOR KEY SHARE OF e`, người xoá `NOT EXISTS` dưới `FOR UPDATE` của dòng endpoint; luật catalog trong `rls-catalog.spec.ts`. | phán quyết R-X33; plan 6C Task 1 Step 5 |
```
Ô có ngoặc của W2 là **dữ liệu đo** điền lúc thực thi (không phải chỗ trống của plan); chọn đúng một câu.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write test/unit/modules/integrations/standard-webhooks.contract.spec.ts test/unit/architecture/rules.spec.ts test/architecture/fixtures/src .dependency-cruiser.cjs renovate.json package.json
git add package.json pnpm-lock.yaml renovate.json .dependency-cruiser.cjs test/unit/architecture/rules.spec.ts test/architecture/fixtures/src test/unit/modules/integrations/standard-webhooks.contract.spec.ts docs/adr/0020-files-audit-webhooks.md
git commit -m "build(integrations): add standardwebhooks 1.1.1; keep spike W1 as a contract test; architecture rule 21; record spikes W1-W3 in ADR 0020"
```

---

## Phần B — Schema (spec §6.5, §6.7, §6.8, §6.9, §6.10 dòng 6C)

### Task 2: Migration `integrations/…_webhooks` — 4 bảng thường, 2 bảng partitioned, hàm bảo trì, hàm quét, quyền `webhooks.*`; catalog, chuẩn hoá, ràng buộc, câu purge dùng chung

**Files:**
- Create: `src/migrations/integrations/Migration<ts>_webhooks.ts` (CLI), `src/modules/integrations/infra/sql/integrations-purge.sql.ts`, `test/support/integrations-seed.ts`, `test/integration/integrations/constraints.spec.ts`, `test/integration/integrations/webhooks-down.spec.ts`
- Create (chỉ nhánh "6A đã merge", Step 6): `src/migrations/integrations/Migration<ts>_webhook_file_events.ts` (CLI)
- Modify: `test/support/core-catalog.ts`, `test/support/tenancy-seed.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: role `partition_owner`, `sweep_definer` (6.0, `docker/postgres/init/01-roles.sh`); `organizations`, `permissions`, `permission_requires` (3A); hằng union của `test/support/core-catalog.ts` (6.0); `migration-scan.spec.ts`, `migration-order.spec.ts`, `migrations.spec.ts` (up → down → up trên database riêng); `seedOrg`, `withAppClient`, `inOrgTx`, `PURGE_ORDER` (`test/support/tenancy-seed.ts`); `ownerQuery`.
- Produces:
  - Bảng `webhook_event_types (type PK, created_at, updated_at)`, 6 dòng tenancy; constraint `webhook_event_types_type_ck`.
  - Bảng `webhook_endpoints`; constraint `webhook_endpoints_org_public_id_uq`, `webhook_endpoints_org_id_uq`, `webhook_endpoints_org_fk`, `webhook_endpoints_url_ck`, `webhook_endpoints_description_ck`, `webhook_endpoints_status_ck`, `webhook_endpoints_disabled_reason_ck`, `webhook_endpoints_disabled_pair_ck`, `webhook_endpoints_deleted_pair_ck`, `webhook_endpoints_purge_after_ck`, `webhook_endpoints_version_ck`; index `webhook_endpoints_live_idx`, `webhook_endpoints_purge_idx`.
  - Bảng `webhook_endpoint_secrets`; constraint `webhook_endpoint_secrets_org_public_id_uq`, `webhook_endpoint_secrets_endpoint_fk` (CASCADE), `webhook_endpoint_secrets_enc_ck`; index `webhook_endpoint_secrets_current_uq`, `webhook_endpoint_secrets_endpoint_idx`.
  - Bảng `webhook_endpoint_event_types`; constraint `webhook_endpoint_event_types_pk`, `webhook_endpoint_event_types_endpoint_fk` (CASCADE), `webhook_endpoint_event_types_type_fk` (RESTRICT); index `webhook_endpoint_event_types_org_type_idx`, `webhook_endpoint_event_types_type_idx`.
  - Bảng partitioned `webhook_messages` (`webhook_messages_pk (created_at, id)`, `webhook_messages_org_id_uq (org_id, id, created_at)`, `webhook_messages_event_type_ck`, `webhook_messages_event_version_ck`, `webhook_messages_body_ck`, index `webhook_messages_org_created_idx`). **Không FK tới `organizations`** (R-X27).
  - Bảng partitioned `webhook_deliveries`; constraint `webhook_deliveries_pk`, `webhook_deliveries_public_id_uq`, `webhook_deliveries_message_endpoint_uq`, `webhook_deliveries_message_fk`, `webhook_deliveries_status_ck`, `webhook_deliveries_cycle_ck`, `webhook_deliveries_local_failures_ck`, `webhook_deliveries_next_attempt_ck`, `webhook_deliveries_lease_ck`, `webhook_deliveries_status_code_ck`, `webhook_deliveries_last_error_ck`, `webhook_deliveries_completed_ck`, `webhook_deliveries_version_ck`; index `webhook_deliveries_endpoint_created_idx`, `webhook_deliveries_due_idx`, `webhook_deliveries_lease_idx`, `webhook_deliveries_endpoint_status_idx`. **Không FK `webhook_deliveries → webhook_endpoints`** (R-X33): bất biến "mọi delivery có endpoint" giữ bằng `FOR KEY SHARE` của người ghi (fan-out) và `NOT EXISTS` dưới khoá endpoint của người xoá (sweep), có test bất biến ở Task 3. Cột `local_failures` (R-X35) đếm lỗi của ta của delivery trong chu kỳ hiện tại (đặt lại `0` khi `retry`/`recover`).
  - Hàm `public.webhook_partitions_maintain(integer, integer) RETURNS TABLE (action text, partition_name text)` (owner `partition_owner`, lockKey 6002, sàn 1) và `public.integrations_orgs_due(uuid, integer, integer) RETURNS TABLE (org_id uuid)` (owner `sweep_definer`).
  - Dòng `permissions` `webhooks.read` (apiKey, support), `webhooks.write` (không apiKey, không support); `permission_requires` `webhooks.write → webhooks.read`.
  - `INTEGRATIONS_PURGE_STATEMENTS: readonly string[]` (`src/modules/integrations/infra/sql/integrations-purge.sql.ts`), dùng chung cho participant (Task 15) và `PURGE_ORDER` của test.
  - `test/support/core-catalog.ts`: `SWEEP_DEFINER_FUNCTIONS_6C`, `SWEEP_DEFINER_READ_TABLES_6C`, `PARTITION_OWNER_FUNCTIONS_6C`, `PARTITIONED_TABLES_6C` nối vào union.
  - `test/support/integrations-seed.ts`: `FAKE_SECRET_ENC`, `type SeededEndpoint = { id: string; publicId: string }`, `type SeededMessage = { id: string; createdAt: string }`, `inOrg<T>(orgId, fn) → Promise<T>`, `orgQuery<T>(orgId, sql, params?) → Promise<T[]>`, `insertEndpoint(c, orgId, o?)`, `insertMessage(c, orgId, o?)`, `insertDelivery(c, orgId, { endpoint, message })` → `{ publicId }`.

- [ ] **Step 1: Catalog, chuẩn hoá, câu purge dùng chung, ràng buộc (viết trước, fail vì bảng chưa có)**

`test/support/core-catalog.ts`: thêm sau các hằng `*_FIXTURE` (không sửa hằng có sẵn; nếu 6A đã thêm hằng `_6A`, giữ nguyên và chỉ thêm phần `_6C`):
```ts
/** Plan 6C (spec SP6 §6.5, §6.7, §6.8). */
export const SWEEP_DEFINER_FUNCTIONS_6C = ['integrations_orgs_due'] as const;
export const SWEEP_DEFINER_READ_TABLES_6C = ['webhook_endpoints', 'webhook_deliveries'] as const;
export const PARTITION_OWNER_FUNCTIONS_6C = ['webhook_partitions_maintain'] as const;
export const PARTITIONED_TABLES_6C = ['webhook_messages', 'webhook_deliveries'] as const;
```
và bốn union thành:
```ts
export const SWEEP_DEFINER_FUNCTIONS: readonly string[] = [...SWEEP_DEFINER_FUNCTIONS_FIXTURE, ...SWEEP_DEFINER_FUNCTIONS_6C];
export const SWEEP_DEFINER_READ_TABLES: readonly string[] = [...SWEEP_DEFINER_READ_TABLES_FIXTURE, ...SWEEP_DEFINER_READ_TABLES_6C];
export const PARTITION_OWNER_FUNCTIONS: readonly string[] = [...PARTITION_OWNER_FUNCTIONS_FIXTURE, ...PARTITION_OWNER_FUNCTIONS_6C];
export const PARTITIONED_TABLES: readonly string[] = [...PARTITIONED_TABLES_FIXTURE, ...PARTITIONED_TABLES_6C];
```

`test/integration/core/database/rls-catalog.spec.ts`: thêm vào `GLOBAL_TABLES`, sau dòng `'kill_switches',`:
```ts
  // SP6 6C (spec §6.5): bảng tra cứu event type công khai của webhook, không thuộc org nào
  'webhook_event_types',
```
Thêm một ca mới ngay sau ca `'no partitioned table or partition references organizations (R-X27, ADR 0020)'` (cùng `describe`, dùng `client` owner của file):
```ts
  it('no partitioned table or partition has a foreign key to a plain table (R-X33, ADR 0020 spike W3)', async () => {
    // DETACH + DROP của partition mang FK như vậy lấy AccessExclusiveLock trên bảng được tham chiếu (spike W3): mọi SELECT
    // của bảng nóng đó bị chặn mỗi tháng. FK giữa hai bảng partitioned (deliveries → messages) không nằm trong luật này.
    const { rows } = await client.query<{ child: string; parent: string }>(
      `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class p ON p.oid = k.confrelid
       WHERE k.contype = 'f' AND (c.relkind = 'p' OR c.relispartition) AND p.relkind = 'r' AND NOT p.relispartition
       ORDER BY 1, 2`,
    );
    expect(rows).toEqual([]);
  });
```
Ca này tổng quát hoá R-X27 (organizations là một bảng thường); giữ cả hai ca vì thông điệp lỗi của ca R-X27 chỉ thẳng tới luật cũ.

Các ca có sẵn tự phủ phần còn lại khi union có hằng 6C (không sửa ca nào): bảng cha partitioned có RLS + FORCE + policy `TO app_user`; partition thuộc `partition_owner`, không grant; không bảng partitioned nào tham chiếu `organizations` (R-X27); `sweep_definer` chỉ có SELECT theo cột, `USING (true)` chỉ trên `SWEEP_DEFINER_READ_TABLES`; tập `SECURITY DEFINER` đúng bằng hợp các hằng (chính xác, không thừa không thiếu) với owner, volatility và `proconfig` (`webhook_partitions_maintain`: `{search_path="",lock_timeout=5s}`); không hàm nào đặt `lock_timeout` trong thân; bảng thường có `org_id` có đường FK tới `organizations` (`webhook_endpoints` trực tiếp, `…_secrets` và `…_event_types` qua FK kép).

`test/integration/core/database/normalization-inventory.spec.ts`: thêm vào `ANALYSED_COLUMNS` (bảng chuẩn hoá spec §6.9 chép vào chú thích migration ở Step 3):
```ts
  'public.webhook_event_types': ['type', 'created_at', 'updated_at'],
  'public.webhook_endpoints': [
    'id', 'public_id', 'org_id', 'url', 'description', 'status', 'disabled_reason', 'failing_since',
    'deleted_at', 'purge_after', 'version', 'created_at', 'updated_at',
  ],
  'public.webhook_endpoint_secrets': ['id', 'public_id', 'org_id', 'endpoint_id', 'secret_enc', 'expires_at', 'created_at', 'updated_at'],
  'public.webhook_endpoint_event_types': ['org_id', 'endpoint_id', 'event_type', 'created_at', 'updated_at'],
  'public.webhook_messages': ['id', 'org_id', 'event_id', 'event_type', 'event_version', 'body', 'created_at', 'updated_at'],
  'public.webhook_deliveries': [
    'id', 'public_id', 'org_id', 'endpoint_id', 'message_id', 'status', 'attempts_total', 'cycle_base', 'local_failures',
    'next_attempt_at', 'lease_until', 'last_attempt_at', 'last_status_code', 'last_error', 'completed_at',
    'version', 'created_at', 'updated_at',
  ],
```

`src/modules/integrations/infra/sql/integrations-purge.sql.ts` (không import gì; seed của test và participant của Task 15 dùng chung):
```ts
/**
 * Participant xoá cứng org `integrations` (spec SP6 §8.3 "Xoá cứng org", R-X5 order 120): con trước cha, trong transaction
 * purge và OrgScope của org. Hai bảng partitioned xoá qua bảng cha (RLS của cha áp cho mọi partition). Không `CASCADE`:
 * thiếu câu `webhook_deliveries` thì câu `webhook_messages` lỗi `23001` (FK partitioned → partitioned). Delivery không có FK
 * tới endpoint (R-X33), nên "không dòng mồ côi" do test purge X-3 (Task 15) khẳng định từng bảng về 0 dòng.
 */
export const INTEGRATIONS_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM webhook_deliveries WHERE org_id = app_current_org()',
  'DELETE FROM webhook_messages WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoint_event_types WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoint_secrets WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoints WHERE org_id = app_current_org()',
];
```
(`no-orphans` của depcruise là `warn`: file chưa được `src` nào import tới Task 15; `pnpm arch` vẫn exit 0.)

`test/support/tenancy-seed.ts`: import và chèn vào `PURGE_ORDER` theo order (entitlements 100 → integrations 120 → tenancy core 1000); sửa chú thích của hằng cho khớp:
```ts
import { INTEGRATIONS_PURGE_STATEMENTS } from '../../src/modules/integrations/infra/sql/integrations-purge.sql.js';
```
```ts
const PURGE_ORDER: readonly string[] = [
  ...ENTITLEMENTS_PURGE_STATEMENTS,
  ...INTEGRATIONS_PURGE_STATEMENTS,
  ...ORG_PURGE_STATEMENTS,
];
```
(Nếu 6A đã merge và chèn câu của files (order 110), giữ thứ tự 100 → 110 → 120 → 1000.)

`test/support/integrations-seed.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 } from 'uuid';
import { inOrgTx, withAppClient } from './tenancy-seed.js';

/** Token đúng định dạng `FieldCipher` v1 (CHECK `webhook_endpoint_secrets_enc_ck`), không giải mã được: chỉ cho test DB. */
export const FAKE_SECRET_ENC = 'v1.t1.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA';

export type SeededEndpoint = { id: string; publicId: string };
export type SeededMessage = { id: string; createdAt: string };

/** Một transaction `app_user` trong OrgScope của org (bảng `webhook_*` có FORCE RLS: `ownerQuery` thấy 0 dòng). */
export function inOrg<T>(orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withAppClient((c) => inOrgTx(c, orgId, () => fn(c)));
}
export function orgQuery<T extends pg.QueryResultRow>(orgId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return inOrg(orgId, async (c) => (await c.query<T>(sql, params)).rows);
}
/** Endpoint (mặc định `ACTIVE`) với các event type (mặc định `tenancy.org.updated`). Chạy trong `inOrg` của caller. */
export async function insertEndpoint(
  c: pg.Client,
  orgId: string,
  o: { url?: string; eventTypes?: readonly string[]; status?: 'ACTIVE' | 'DISABLED' } = {},
): Promise<SeededEndpoint> {
  const status = o.status ?? 'ACTIVE';
  const { rows } = await c.query<{ id: string; public_id: string }>(
    `INSERT INTO webhook_endpoints (org_id, url, status, disabled_reason) VALUES ($1, $2, $3, $4) RETURNING id::text, public_id::text`,
    [orgId, o.url ?? `https://hooks.example.test/${randomUUID()}`, status, status === 'DISABLED' ? 'MANUAL' : null],
  );
  const e = rows[0];
  if (!e) throw new Error('seed: endpoint insert returned no row');
  for (const t of o.eventTypes ?? ['tenancy.org.updated'])
    await c.query(`INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type) VALUES ($1, $2, $3)`, [orgId, e.id, t]);
  return { id: e.id, publicId: e.public_id };
}
/** `createdAt` là chuỗi ISO micro giây (UTC), đúng khoá mà repository dùng cho CAS. */
export async function insertMessage(
  c: pg.Client,
  orgId: string,
  o: { eventType?: string; createdAt?: string; body?: string } = {},
): Promise<SeededMessage> {
  const { rows } = await c.query<{ id: string; created_at: string }>(
    `INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body, created_at)
     VALUES ($1, $2, $3, 1, $4, COALESCE($5::timestamptz, now()))
     RETURNING id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [orgId, v7(), o.eventType ?? 'tenancy.org.updated', o.body ?? '{}', o.createdAt ?? null],
  );
  const m = rows[0];
  if (!m) throw new Error('seed: message insert returned no row');
  return { id: m.id, createdAt: m.created_at };
}
/** Delivery `PENDING`, đến hạn ngay, cùng `created_at` với message (FK ép). */
export async function insertDelivery(
  c: pg.Client,
  orgId: string,
  o: { endpoint: SeededEndpoint; message: SeededMessage },
): Promise<{ publicId: string }> {
  const publicId = v7();
  await c.query(
    `INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'PENDING', now())`,
    [publicId, orgId, o.endpoint.id, o.message.id, o.message.createdAt],
  );
  return { publicId };
}
```

`test/integration/integrations/constraints.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { FAKE_SECRET_ENC, inOrg, insertDelivery, insertEndpoint, insertMessage } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const ep = (o: SeededOrg) => inOrg(o.orgId, (c) => insertEndpoint(c, o.orgId));
const delivery = (o: SeededOrg) =>
  inOrg(o.orgId, async (c) => {
    const endpoint = await insertEndpoint(c, o.orgId);
    const message = await insertMessage(c, o.orgId);
    return { endpoint, message, ...(await insertDelivery(c, o.orgId, { endpoint, message })) };
  });

describe('webhook schema invariants live in the DB (spec SP6 §6.5)', () => {
  let org: SeededOrg;
  beforeAll(async () => {
    applyTestEnv();
    org = await seedOrg();
  });
  afterAll(async () => org?.dispose());

  it('the event type catalogue holds the six tenancy webhook events', async () => {
    const rows = await ownerQuery<{ type: string }>(`SELECT type FROM webhook_event_types WHERE type LIKE 'tenancy.%' ORDER BY type`);
    expect(rows.map((r) => r.type)).toEqual([
      'tenancy.member.added', 'tenancy.member.removed', 'tenancy.member.role_changed',
      'tenancy.org.deleted', 'tenancy.org.restored', 'tenancy.org.updated',
    ]);
  });
  it.each([
    ['a url that is not http(s)', 'ftp://files.example.test/x', 'ACTIVE', null],
    ['a url shorter than 10 characters', 'https://a', 'ACTIVE', null],
    ['DISABLED without a reason', 'https://hooks.example.test/x', 'DISABLED', null],
    ['a reason while ACTIVE', 'https://hooks.example.test/x', 'ACTIVE', 'MANUAL'],
    ['an unknown status', 'https://hooks.example.test/x', 'PAUSED', null],
  ] as const)('endpoint CHECK refuses %s (23514)', async (_name, url, status, reason) => {
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(`INSERT INTO webhook_endpoints (org_id, url, status, disabled_reason) VALUES ($1, $2, $3, $4)`, [org.orgId, url, status, reason]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('deleted_at and purge_after come together, and purge_after is after deleted_at', async () => {
    const e = await ep(org);
    await expect(inOrg(org.orgId, (c) => c.query(`UPDATE webhook_endpoints SET deleted_at = now() WHERE id = $1`, [e.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_endpoints_deleted_pair_ck',
    });
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(`UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() - interval '1 second' WHERE id = $1`, [e.id]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'webhook_endpoints_purge_after_ck' });
  });
  it('at most one current secret per endpoint; a plaintext secret is refused', async () => {
    const e = await ep(org);
    const insert = (enc: string, expired: boolean) =>
      inOrg(org.orgId, (c) =>
        c.query(
          `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc, expires_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)`,
          [org.orgId, e.id, enc, expired],
        ),
      );
    await insert(FAKE_SECRET_ENC, false);
    await expect(insert(FAKE_SECRET_ENC, false)).rejects.toMatchObject({ code: '23505', constraint: 'webhook_endpoint_secrets_current_uq' });
    await expect(insert('whsec_plain', true)).rejects.toMatchObject({ code: '23514', constraint: 'webhook_endpoint_secrets_enc_ck' });
  });
  it('an unknown event type cannot be subscribed (FK to webhook_event_types)', async () => {
    const e = await inOrg(org.orgId, (c) => insertEndpoint(c, org.orgId, { eventTypes: [] }));
    await expect(
      inOrg(org.orgId, (c) =>
        c.query(`INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type) VALUES ($1, $2, 'tenancy.org.created')`, [org.orgId, e.id]),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'webhook_endpoint_event_types_type_fk' });
  });
  it('message body over 262144 bytes and an event type outside the pattern are refused; webhook.test is accepted', async () => {
    await expect(inOrg(org.orgId, (c) => insertMessage(c, org.orgId, { body: 'x'.repeat(262_145) }))).rejects.toMatchObject({
      code: '23514',
      constraint: 'webhook_messages_body_ck',
    });
    await expect(inOrg(org.orgId, (c) => insertMessage(c, org.orgId, { eventType: 'Bad Type' }))).rejects.toMatchObject({ code: '23514' });
    await expect(inOrg(org.orgId, (c) => insertMessage(c, org.orgId, { eventType: 'webhook.test' }))).resolves.toBeDefined();
  });
  it.each([
    ['SENDING without a lease', `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL WHERE public_id = $1`],
    ['PENDING without next_attempt_at', `UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE public_id = $1`],
    ['SUCCEEDED without completed_at', `UPDATE webhook_deliveries SET status = 'SUCCEEDED', next_attempt_at = NULL WHERE public_id = $1`],
    ['cycle_base above attempts_total', `UPDATE webhook_deliveries SET cycle_base = attempts_total + 1 WHERE public_id = $1`],
    ['an unknown last_error', `UPDATE webhook_deliveries SET last_error = 'OOPS' WHERE public_id = $1`],
    ['a negative local_failures', `UPDATE webhook_deliveries SET local_failures = -1 WHERE public_id = $1`],
    ['a status code of 99', `UPDATE webhook_deliveries SET last_status_code = 99 WHERE public_id = $1`],
  ])('delivery CHECK refuses %s (23514)', async (_name, sql) => {
    const d = await delivery(org);
    await expect(inOrg(org.orgId, (c) => c.query(sql, [d.publicId]))).rejects.toMatchObject({ code: '23514' });
  });
  it('a delivery carries the created_at of its message (FK includes created_at)', async () => {
    await expect(
      inOrg(org.orgId, async (c) => {
        const endpoint = await insertEndpoint(c, org.orgId);
        const message = await insertMessage(c, org.orgId);
        const shifted = { id: message.id, createdAt: new Date(Date.parse(message.createdAt) + 1000).toISOString() };
        return insertDelivery(c, org.orgId, { endpoint, message: shifted });
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'webhook_deliveries_message_fk' });
  });
  it('one delivery per (message, endpoint)', async () => {
    const d = await delivery(org);
    await expect(inOrg(org.orgId, (c) => insertDelivery(c, org.orgId, { endpoint: d.endpoint, message: d.message }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'webhook_deliveries_message_endpoint_uq',
    });
  });
  it('SECRET_UNAVAILABLE is an accepted last_error (R-X35 local failure)', async () => {
    const d = await delivery(org);
    const r = await inOrg(org.orgId, (c) =>
      c.query(`UPDATE webhook_deliveries SET last_error = 'SECRET_UNAVAILABLE', local_failures = 1 WHERE public_id = $1`, [d.publicId]),
    );
    expect(r.rowCount).toBe(1);
  });
  it('seeds webhooks.read (apiKey, support) and webhooks.write (requires read, neither apiKey nor support)', async () => {
    const rows = await ownerQuery(
      `SELECT p.key, p.owner_only, p.api_key_eligible, p.support_eligible,
         coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM permission_requires q JOIN permissions r ON r.id = q.required_permission_id
                   WHERE q.permission_id = p.id), '{}') AS requires
       FROM permissions p WHERE p.key IN ('webhooks.read', 'webhooks.write') ORDER BY p.key`,
    );
    expect(rows).toEqual([
      { key: 'webhooks.read', owner_only: false, api_key_eligible: true, support_eligible: true, requires: [] },
      { key: 'webhooks.write', owner_only: false, api_key_eligible: false, support_eligible: false, requires: ['webhooks.read'] },
    ]);
  });
});
```
(Không có ca "xoá endpoint còn delivery → 23001": R-X33 bỏ FK đó. Bất biến "mọi delivery có endpoint" được test ở Task 3 Step 1 trên đường ghi/xoá thật.)

Run:
```bash
pnpm vitest run --project integration test/integration/integrations/constraints.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
```
Expected: FAIL. `constraints.spec.ts`: `relation "webhook_endpoints" does not exist` (mọi `seedOrg().dispose()` cũng lỗi vì `PURGE_ORDER` chứa câu trên bảng chưa có — RED đúng của bước này); catalog: thiếu hàm/bảng 6C; normalization: `[]` khác danh sách cột.

- [ ] **Step 2: Sinh file migration**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/integrations --name webhooks`
Expected: file `src/migrations/integrations/Migration<14 chữ số>_webhooks.ts`, timestamp lớn hơn `20261005164759`.

- [ ] **Step 3: Nội dung migration**

Sửa file vừa sinh (giữ tên lớp và `name` do CLI sinh; khối dưới viết tên lớp minh hoạ `Migration20261007000000_webhooks`):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan SP6 6C (spec SP6 §6.5, §6.7, §6.8, §6.10 dòng 6C).
 *
 * Bảng chuẩn hoá (spec §6.9; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | webhook_event_types | {type} | — | BCNF |
 * | webhook_endpoints | {id}, {org_id, public_id} | — | BCNF (`disabled_reason` gắn `status` bằng CHECK hai chiều) |
 * | webhook_endpoint_secrets | {id}, {org_id, public_id}, {org_id, endpoint_id} khi expires_at IS NULL | endpoint_id → org_id | 3NF; E1 |
 * | webhook_endpoint_event_types | {org_id, endpoint_id, event_type} | endpoint_id → org_id | 1NF hình thức; E1 |
 * | webhook_messages | {created_at, id}; {id} về ngữ nghĩa | — | BCNF (body thuộc message, không lặp ở delivery) |
 * | webhook_deliveries | {created_at, id}, {public_id, created_at}, {org_id, message_id, created_at, endpoint_id} | endpoint_id → org_id; message_id → created_at, org_id | 3NF; E1 |
 * E1 (SP3): `org_id` lặp ở bảng con cho RLS không join; nhất quán bằng FK kép `(org_id, x_id)`, không grant UPDATE trên
 * `org_id`, policy `WITH CHECK (org_id = app_current_org())`. `created_at` của delivery bằng của message: FK
 * `(org_id, message_id, created_at)` ép. Bảng partitioned không FK tới `organizations` (R-X27): `org_id` được giữ bằng RLS +
 * ghi trong OrgScope + participant purge.
 *
 * Index (mỗi cái một query):
 * - `webhook_endpoints_org_public_id_uq` (API), `webhook_endpoints_org_id_uq` (đích FK kép);
 * - `webhook_endpoints_live_idx` (đếm giới hạn mỗi org R6-26, fan-out, WebhookStatsReader);
 * - `webhook_endpoints_purge_idx` (hàm quét xuyên org, sweep xoá cứng);
 * - `webhook_endpoint_secrets_current_uq` (một secret hiện hành), `webhook_endpoint_secrets_endpoint_idx` (đọc secret còn hạn lúc claim);
 * - `webhook_endpoint_event_types_org_type_idx` (fan-out theo event), `webhook_endpoint_event_types_type_idx` (FK RESTRICT từ catalog);
 * - `webhook_messages_org_created_idx` (participant purge);
 * - `webhook_deliveries_public_id_uq` (job/API tra theo id; không prune partition: ≤ retention + premake partition, S6-A26);
 * - `webhook_deliveries_message_endpoint_uq` (một delivery mỗi message × endpoint; tiền tố `(org_id, message_id, created_at)` phục vụ FK RESTRICT khi xoá message);
 * - `webhook_deliveries_endpoint_created_idx` (danh sách delivery của endpoint, keyset `(created_at, public_id)` giảm dần; `NOT EXISTS` của sweep xoá cứng endpoint);
 * - `webhook_deliveries_due_idx`, `webhook_deliveries_lease_idx` (hàm quét và sweep);
 * - `webhook_deliveries_endpoint_status_idx` (recover, `?status=`, đếm `SENDING` của endpoint lúc claim — bulkhead R-X35).
 *
 * Owner: bảng thường thuộc app_owner; hai bảng partitioned và hàm bảo trì thuộc `partition_owner`; hàm quét thuộc
 * `sweep_definer` (tạo/xoá DƯỚI `SET LOCAL ROLE`, spec §3.2). R-X33 (spike W3): không FK từ bảng partitioned tới bảng thường
 * nóng — `DETACH` + `DROP` partition mang FK `webhook_deliveries → webhook_endpoints` lấy `AccessExclusiveLock` trên
 * `webhook_endpoints` (chặn cả SELECT), `ATTACH` lấy `ShareRowExclusiveLock` (chặn ghi). Vì vậy `partition_owner` không nhận
 * REFERENCES nào trên bảng thường; bất biến "mọi delivery có endpoint" giữ bằng `FOR KEY SHARE OF e` khi fan-out chèn delivery
 * và `NOT EXISTS` dưới `FOR UPDATE` của dòng endpoint khi sweep xoá cứng (Task 10, Task 11), test ở Task 3.
 * Hằng viết cứng (migration không import code; `constants-vs-migration.spec.ts` so với code): lockKey 6002 =
 * `WEBHOOK_PARTITIONS_LOCK_KEY`, sàn retention 1 = `WEBHOOK_RETENTION_MIN_MONTHS`, 262144 = `WEBHOOK_BODY_MAX_BYTES`, 10/2048 =
 * `WEBHOOK_URL_MIN_LENGTH`/`_MAX_LENGTH`, 500 = `WEBHOOK_DESCRIPTION_MAX_LENGTH`, p_limit 1000 = `DEFINER_LIMIT_MAX`, tập
 * `last_error` = `LAST_ERRORS`.
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `organizations` (FK của `webhook_endpoints`),
 * ngắn. Down (mẫu "down có canh" của 3B/4B): từ chối khi còn endpoint hoặc secret (xoá chúng là mất cấu hình và secret của
 * khách, không khôi phục được); bỏ FORCE trước câu kiểm vì dưới FORCE app_owner thấy 0 dòng, `ALTER TABLE` lấy ACCESS
 * EXCLUSIVE giữ tới hết lô nên không ghi nào chen giữa câu kiểm và DROP. Còn bị FK RESTRICT chặn khi role tuỳ biến (3B) còn giữ
 * `webhooks.*` (lỗi to; runbook gỡ quyền khỏi role trước).
 */
export class Migration20261007000000_webhooks extends Migration {
  override name = 'Migration20261007000000_webhooks';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer') THEN
    RAISE EXCEPTION 'roles partition_owner/sweep_definer are missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE webhook_event_types (
    type TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_event_types_type_ck CHECK (type ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'));`);
    this.addSql(`GRANT SELECT ON webhook_event_types TO app_user;`);
    // Hợp đồng công khai (spec §8.3): sáu event tenancy có `webhook: true` (6.0). `WebhookEventCatalogueCheck` so lúc boot.
    this.addSql(`INSERT INTO webhook_event_types (type) VALUES
    ('tenancy.member.added'), ('tenancy.member.removed'), ('tenancy.member.role_changed'),
    ('tenancy.org.updated'), ('tenancy.org.deleted'), ('tenancy.org.restored');`);

    this.addSql(`CREATE TABLE webhook_endpoints (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    url TEXT NOT NULL,
    description TEXT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    disabled_reason TEXT NULL,
    failing_since TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL,
    purge_after TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoints_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT webhook_endpoints_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT webhook_endpoints_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT webhook_endpoints_url_ck CHECK (char_length(url) BETWEEN 10 AND 2048 AND url ~ '^https?://'),
    CONSTRAINT webhook_endpoints_description_ck CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500),
    CONSTRAINT webhook_endpoints_status_ck CHECK (status IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT webhook_endpoints_disabled_reason_ck CHECK (disabled_reason IN ('MANUAL', 'AUTO_FAILING')),
    CONSTRAINT webhook_endpoints_disabled_pair_ck CHECK ((status = 'DISABLED') = (disabled_reason IS NOT NULL)),
    CONSTRAINT webhook_endpoints_deleted_pair_ck CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
    CONSTRAINT webhook_endpoints_purge_after_ck CHECK (purge_after > deleted_at),
    CONSTRAINT webhook_endpoints_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE INDEX webhook_endpoints_live_idx ON webhook_endpoints (org_id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX webhook_endpoints_purge_idx ON webhook_endpoints (purge_after) WHERE deleted_at IS NOT NULL;`);
    this.addSql(`ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY webhook_endpoints_tenant ON webhook_endpoints TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY webhook_endpoints_definer_read ON webhook_endpoints FOR SELECT TO sweep_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON webhook_endpoints TO app_user;`);
    this.addSql(
      `GRANT UPDATE (url, description, status, disabled_reason, failing_since, deleted_at, purge_after, version, updated_at) ON webhook_endpoints TO app_user;`,
    );
    this.addSql(`GRANT SELECT (org_id, purge_after, deleted_at) ON webhook_endpoints TO sweep_definer;`);

    this.addSql(`CREATE TABLE webhook_endpoint_secrets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    secret_enc TEXT NOT NULL,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoint_secrets_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT webhook_endpoint_secrets_endpoint_fk FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_endpoint_secrets_enc_ck CHECK (secret_enc ~ '^v1\\.[a-z0-9]{1,16}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{22}$'));`);
    this.addSql(`CREATE UNIQUE INDEX webhook_endpoint_secrets_current_uq ON webhook_endpoint_secrets (org_id, endpoint_id) WHERE expires_at IS NULL;`);
    this.addSql(`CREATE INDEX webhook_endpoint_secrets_endpoint_idx ON webhook_endpoint_secrets (org_id, endpoint_id);`);
    this.addSql(`ALTER TABLE webhook_endpoint_secrets ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_endpoint_secrets FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY webhook_endpoint_secrets_tenant ON webhook_endpoint_secrets TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON webhook_endpoint_secrets TO app_user;`);
    this.addSql(`GRANT UPDATE (expires_at, updated_at) ON webhook_endpoint_secrets TO app_user;`);

    this.addSql(`CREATE TABLE webhook_endpoint_event_types (
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoint_event_types_pk PRIMARY KEY (org_id, endpoint_id, event_type),
    CONSTRAINT webhook_endpoint_event_types_endpoint_fk FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_endpoint_event_types_type_fk FOREIGN KEY (event_type) REFERENCES webhook_event_types (type) ON DELETE RESTRICT);`);
    this.addSql(`CREATE INDEX webhook_endpoint_event_types_org_type_idx ON webhook_endpoint_event_types (org_id, event_type);`);
    this.addSql(`CREATE INDEX webhook_endpoint_event_types_type_idx ON webhook_endpoint_event_types (event_type);`);
    this.addSql(`ALTER TABLE webhook_endpoint_event_types ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_endpoint_event_types FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY webhook_endpoint_event_types_tenant ON webhook_endpoint_event_types TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON webhook_endpoint_event_types TO app_user;`);

    // R-X27, R-X33: partition_owner không nhận REFERENCES trên bảng thường nào (không FK partitioned → bảng thường).
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`CREATE TABLE webhook_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    event_version INT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_messages_pk PRIMARY KEY (created_at, id),
    CONSTRAINT webhook_messages_org_id_uq UNIQUE (org_id, id, created_at),
    CONSTRAINT webhook_messages_event_type_ck CHECK (event_type ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' OR event_type = 'webhook.test'),
    CONSTRAINT webhook_messages_event_version_ck CHECK (event_version > 0),
    CONSTRAINT webhook_messages_body_ck CHECK (octet_length(body) <= 262144)) PARTITION BY RANGE (created_at);`);
    this.addSql(`CREATE INDEX webhook_messages_org_created_idx ON webhook_messages (org_id, created_at);`);
    this.addSql(`ALTER TABLE webhook_messages ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_messages FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY webhook_messages_tenant ON webhook_messages TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    // Message bất biến sau khi ghi: không grant UPDATE.
    this.addSql(`GRANT SELECT, INSERT, DELETE ON webhook_messages TO app_user;`);

    this.addSql(`CREATE TABLE webhook_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    public_id UUID NOT NULL,
    org_id UUID NOT NULL,
    endpoint_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    status TEXT NOT NULL,
    attempts_total INT NOT NULL DEFAULT 0,
    cycle_base INT NOT NULL DEFAULT 0,
    local_failures INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NULL,
    lease_until TIMESTAMPTZ NULL,
    last_attempt_at TIMESTAMPTZ NULL,
    last_status_code INT NULL,
    last_error TEXT NULL,
    completed_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_pk PRIMARY KEY (created_at, id),
    CONSTRAINT webhook_deliveries_public_id_uq UNIQUE (public_id, created_at),
    CONSTRAINT webhook_deliveries_message_endpoint_uq UNIQUE (org_id, message_id, created_at, endpoint_id),
    CONSTRAINT webhook_deliveries_message_fk FOREIGN KEY (org_id, message_id, created_at) REFERENCES public.webhook_messages (org_id, id, created_at) ON DELETE RESTRICT,
    CONSTRAINT webhook_deliveries_status_ck CHECK (status IN ('PENDING', 'SENDING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'EXHAUSTED', 'CANCELLED')),
    CONSTRAINT webhook_deliveries_cycle_ck CHECK (0 <= cycle_base AND cycle_base <= attempts_total),
    CONSTRAINT webhook_deliveries_local_failures_ck CHECK (local_failures >= 0),
    CONSTRAINT webhook_deliveries_next_attempt_ck CHECK ((status IN ('PENDING', 'RETRY_SCHEDULED')) = (next_attempt_at IS NOT NULL)),
    CONSTRAINT webhook_deliveries_lease_ck CHECK ((status = 'SENDING') = (lease_until IS NOT NULL)),
    CONSTRAINT webhook_deliveries_status_code_ck CHECK (last_status_code BETWEEN 100 AND 599),
    CONSTRAINT webhook_deliveries_last_error_ck CHECK (last_error IN ('TIMEOUT', 'NETWORK', 'SERVER_ERROR', 'CLIENT_ERROR', 'REDIRECT', 'RATE_LIMITED', 'SSRF_BLOCKED', 'TOO_LARGE', 'BULKHEAD_FULL', 'CIRCUIT_OPEN', 'LEASE_EXPIRED', 'SECRET_UNAVAILABLE', 'ENDPOINT_UNAVAILABLE')),
    CONSTRAINT webhook_deliveries_completed_ck CHECK ((status IN ('SUCCEEDED', 'EXHAUSTED', 'CANCELLED')) = (completed_at IS NOT NULL)),
    CONSTRAINT webhook_deliveries_version_ck CHECK (version >= 1)) PARTITION BY RANGE (created_at);`);
    this.addSql(`CREATE INDEX webhook_deliveries_endpoint_created_idx ON webhook_deliveries (org_id, endpoint_id, created_at DESC, public_id DESC);`);
    this.addSql(`CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('PENDING', 'RETRY_SCHEDULED');`);
    this.addSql(`CREATE INDEX webhook_deliveries_lease_idx ON webhook_deliveries (lease_until) WHERE status = 'SENDING';`);
    this.addSql(`CREATE INDEX webhook_deliveries_endpoint_status_idx ON webhook_deliveries (org_id, endpoint_id, status, created_at);`);
    this.addSql(`ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY webhook_deliveries_definer_read ON webhook_deliveries FOR SELECT TO sweep_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON webhook_deliveries TO app_user;`);
    this.addSql(
      `GRANT UPDATE (status, attempts_total, cycle_base, local_failures, next_attempt_at, lease_until, last_attempt_at, last_status_code, last_error, completed_at, version, updated_at) ON webhook_deliveries TO app_user;`,
    );
    this.addSql(`GRANT SELECT (org_id, status, next_attempt_at, lease_until) ON webhook_deliveries TO sweep_definer;`);

    // Hàm bảo trì (spec §6.7; mẫu của fixture 6.0): lock_timeout là thuộc tính hàm; drop deliveries trước messages (spike P2).
    this.addSql(`CREATE FUNCTION public.webhook_partitions_maintain(p_retention_months integer, p_premake_months integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s' AS $$
#variable_conflict use_column
DECLARE
  v_base timestamp;
  v_lo timestamp;
  v_name text;
  v_cutoff timestamp;
  v_table text;
  r record;
BEGIN
  IF p_retention_months IS NULL OR p_premake_months IS NULL THEN
    RAISE EXCEPTION 'webhook_partitions_maintain: arguments must not be NULL';
  END IF;
  -- Sàn retention cứng ở đây (WEBHOOK_RETENTION_MIN_MONTHS): SQLi bằng app_user không hạ được dưới sàn.
  IF p_retention_months < 1 OR p_retention_months > 120 THEN
    RAISE EXCEPTION 'webhook_partitions_maintain: p_retention_months must be between 1 and 120';
  END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN
    RAISE EXCEPTION 'webhook_partitions_maintain: p_premake_months must be between 1 and 12';
  END IF;
  -- R6-17: một lượt mỗi lúc (WEBHOOK_PARTITIONS_LOCK_KEY); lượt thứ hai là no-op.
  IF NOT pg_try_advisory_xact_lock(6002) THEN RETURN; END IF;
  -- Mốc tháng theo UTC, không theo TimeZone của session.
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOREACH v_table IN ARRAY ARRAY['webhook_messages', 'webhook_deliveries'] LOOP
    FOR i IN 0..p_premake_months LOOP
      v_lo := v_base + make_interval(months => i);
      v_name := v_table || '_p' || to_char(v_lo, 'YYYYMM');
      IF to_regclass('public.' || v_name) IS NULL THEN
        EXECUTE format('CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name, v_table);
        EXECUTE format('ALTER TABLE public.%I ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
          v_table, v_name, v_lo AT TIME ZONE 'UTC', (v_lo + interval '1 month') AT TIME ZONE 'UTC');
        action := 'created'; partition_name := v_name; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  v_cutoff := v_base - make_interval(months => p_retention_months);
  -- Spike P2: partition deliveries của tháng M đi trước partition messages cùng tháng (FK deliveries → messages).
  FOREACH v_table IN ARRAY ARRAY['webhook_deliveries', 'webhook_messages'] LOOP
    FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = ('public.' || v_table)::regclass ORDER BY c.relname LOOP
      IF r.relname !~ ('^' || v_table || '_p[0-9]{6}$') THEN
        RAISE EXCEPTION 'webhook_partitions_maintain: unexpected partition %', r.relname;
      END IF;
      v_lo := to_date(substring(r.relname FROM '[0-9]{6}$'), 'YYYYMM')::timestamp;
      IF v_lo + interval '1 month' <= v_cutoff THEN
        EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', v_table, r.relname);
        EXECUTE format('DROP TABLE public.%I', r.relname);
        action := 'dropped'; partition_name := r.relname; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.webhook_partitions_maintain(integer, integer) FROM PUBLIC;`);
    this.addSql(`GRANT EXECUTE ON FUNCTION public.webhook_partitions_maintain(integer, integer) TO app_user;`);
    // Partition đầu (tháng hiện tại + 3 tháng tới = mặc định INTEGRATIONS_PARTITION_PREMAKE_MONTHS) do chính hàm tạo.
    this.addSql(`SELECT count(*) FROM public.webhook_partitions_maintain(1, 3);`);
    this.addSql(`RESET ROLE;`);

    // Hàm quét xuyên org (spec §6.8, R-X4, R-X14): owner sweep_definer, chữ ký (p_after, p_limit) + p_grace_sec theo tên.
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(`CREATE FUNCTION public.integrations_orgs_due(p_after uuid, p_limit integer, p_grace_sec integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_grace_sec IS NULL THEN
    RAISE EXCEPTION 'integrations_orgs_due: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'integrations_orgs_due: p_limit must be between 1 and 1000'; END IF;
  IF p_grace_sec < 1 OR p_grace_sec > 86400 THEN
    RAISE EXCEPTION 'integrations_orgs_due: p_grace_sec must be between 1 and 86400';
  END IF;
  RETURN QUERY
    SELECT u.org_id FROM (
      SELECT d.org_id FROM public.webhook_deliveries d
       WHERE d.status IN ('PENDING', 'RETRY_SCHEDULED') AND d.next_attempt_at <= now() - make_interval(secs => p_grace_sec)
         AND d.org_id > p_after
      UNION
      SELECT d.org_id FROM public.webhook_deliveries d
       WHERE d.status = 'SENDING' AND d.lease_until <= now() - make_interval(secs => p_grace_sec) AND d.org_id > p_after
      UNION
      SELECT e.org_id FROM public.webhook_endpoints e
       WHERE e.deleted_at IS NOT NULL AND e.purge_after <= now() AND e.org_id > p_after
    ) u
    ORDER BY u.org_id LIMIT p_limit;
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.integrations_orgs_due(uuid, integer, integer) FROM PUBLIC;`);
    this.addSql(`GRANT EXECUTE ON FUNCTION public.integrations_orgs_due(uuid, integer, integer) TO app_user;`);
    this.addSql(`RESET ROLE;`);

    // Catalogue `integrations` (spec §9.1): `CatalogueCheck` của tenancy so với `WebhookPermissions` lúc boot (Task 5).
    this.addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('webhooks', 'read', false, true, true),
    ('webhooks', 'write', false, false, false);`);
    this.addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'webhooks.read' WHERE p.key = 'webhooks.write';`);
  }

  override down(): void | Promise<void> {
    // Down có canh (mẫu 3B/4B): dưới FORCE app_owner không có policy nên thấy 0 dòng; bỏ FORCE để câu kiểm thấy thật.
    // ALTER TABLE lấy ACCESS EXCLUSIVE giữ tới hết lô: tạo endpoint/xoay secret đang mở thì down chờ nó, rồi thấy dòng của nó.
    // RAISE → cả lô rollback, FORCE còn nguyên.
    this.addSql(`ALTER TABLE public.webhook_endpoints NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE public.webhook_endpoint_secrets NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_endpoints) OR EXISTS (SELECT 1 FROM public.webhook_endpoint_secrets) THEN
    RAISE EXCEPTION 'webhook endpoints or secrets exist; reverting the webhooks migration would destroy customer webhook configuration and signing secrets';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM permission_requires WHERE permission_id = (SELECT id FROM permissions WHERE key = 'webhooks.write');`);
    this.addSql(`DELETE FROM permissions WHERE key IN ('webhooks.write', 'webhooks.read');`);
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(`DROP FUNCTION public.integrations_orgs_due(uuid, integer, integer);`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`DROP TABLE webhook_deliveries;`);
    this.addSql(`DROP TABLE webhook_messages;`);
    this.addSql(`DROP FUNCTION public.webhook_partitions_maintain(integer, integer);`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE webhook_endpoint_event_types;`);
    this.addSql(`DROP TABLE webhook_endpoint_secrets;`);
    this.addSql(`DROP TABLE webhook_endpoints;`);
    this.addSql(`DROP TABLE webhook_event_types;`);
    // Bước 7 của mẫu SP3 §8.8 (`migration-scan.spec.ts` đòi khối này sau `NO FORCE` cuối cùng): không bảng tenant nào còn
    // lại mà mất FORCE.
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
  }
}
```
(Chuỗi `\\.` trong template literal thành `\.` trong SQL. `CHECK` của `secret_enc` là đúng `CIPHERTEXT_PATTERN` của `src/core/security/field-cipher.ts`.)

Không có nhánh fallback: R-X33 biến phương án "không FK partitioned → `webhook_endpoints`" thành mặc định (spike W3 là kết quả đã đo, Task 1 Step 5). Người ghi delivery giữ dòng endpoint: fan-out lấy `FOR KEY SHARE OF e` (Task 10); retry, recover, gửi thử lấy `FOR SHARE` (mạnh hơn, Task 14). Người xoá cứng dòng endpoint (chỉ sweep, Task 11) lấy `FOR UPDATE` (xung đột với cả hai) rồi kiểm `NOT EXISTS` delivery bằng câu riêng **sau** khi có khoá (snapshot mới của READ COMMITTED thấy mọi delivery của người ghi vừa nhả khoá).

`test/integration/integrations/webhooks-down.spec.ts` (M4, mẫu `test/integration/entitlements/usage-counters-down.spec.ts`; database riêng vì down để lại schema khác DB dùng chung):
```ts
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { FAKE_SECRET_ENC, insertEndpoint } from '../../support/integrations-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const POLL_MS = 20;
const LOCK_DEADLINE_MS = 8_000;
const REFUSAL = /webhook endpoints or secrets exist/;

/** M4 (review 6C): down của `…_webhooks` không xoá cấu hình webhook và secret của khách; atomic với ghi đang mở. */
describe('webhooks down refuses while endpoints or secrets exist', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let org: SeededOrg;
  const inOrgDb = <T>(fn: (c: pg.Client) => Promise<T>) => withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const tables = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{ endpoints: string | null; force: boolean | null }>(
          `SELECT to_regclass('public.webhook_endpoints')::text AS endpoints,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.webhook_endpoints')) AS force`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = () => runMigrations('down', { source: { kind: 'list', list }, to: before });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('whdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_webhooks'));
    if (at < 1) throw new Error('webhooks migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) refuses while an endpoint exists; the table and FORCE stay', async () => {
    const e = await inOrgDb((c) => insertEndpoint(c, org.orgId));
    await expect(down()).rejects.toThrow(REFUSAL);
    expect(await tables()).toEqual({ endpoints: 'webhook_endpoints', force: true });
    await inOrgDb((c) => c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [e.id]));
  });
  it('(b) atomic: a secret committed while the down waits on the table lock is seen, and the down refuses', async () => {
    const e = await inOrgDb((c) => insertEndpoint(c, org.orgId));
    await inOrgDb((c) => c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [e.id]));
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      const { rows } = await writer.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, url) VALUES (app_current_org(), 'https://hooks.example.test/down') RETURNING id::text`,
      );
      await writer.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES (app_current_org(), $1, $2)`, [
        rows[0]!.id,
        FAKE_SECRET_ENC,
      ]);
      const pending = down();
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows: w } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.webhook_endpoints')`,
          );
          if ((w[0]?.n ?? 0) > 0) break;
          if (Date.now() > until) throw new Error('the down never waited on the webhook_endpoints lock');
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        await watcher.end();
      }
      await writer.query('COMMIT');
      await expect(pending).rejects.toThrow(REFUSAL);
    } finally {
      await writer.end();
    }
    await inOrgDb((c) => c.query(`DELETE FROM webhook_endpoints`));
  });
  it('(c) with no endpoint and no secret the down drops the schema; up restores it', async () => {
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(await tables()).toEqual({ endpoints: null, force: null });
    await runMigrations('up', { source: { kind: 'list', list } });
    expect(await tables()).toEqual({ endpoints: 'webhook_endpoints', force: true });
  });
});
```
(`DELETE FROM webhook_endpoints` xoá secret và event type theo FK CASCADE; trong scratch DB không có delivery. `seedOrg` không `dispose` vì `PURGE_ORDER` chạm bảng đã bị down; scratch DB bị drop ở `afterAll`, như test 4B.)

- [ ] **Step 4: Chạy catalog, chuẩn hoá, ràng buộc, quét tĩnh, up/down**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/integrations/constraints.spec.ts test/integration/integrations/webhooks-down.spec.ts test/integration/core/database
```
Expected: PASS.
- `migration-scan.spec.ts`: hàm của hai role nằm trong khối `SET LOCAL ROLE … RESET ROLE` đúng role (`OWNED_FUNCTIONS` có hằng 6C qua union); `CREATE TABLE … PARTITION BY` chỉ dưới `partition_owner`; mọi hàm tạo ở `up` bị xoá ở `down`.
- `migration-order.spec.ts`: timestamp mới nhất của vùng boilerplate.
- `migrations.spec.ts`: up → down → up và sweep S2-R57 trên database riêng (down đối xứng được test thật).
- `rls-catalog.spec.ts`: 8 partition (2 bảng × 4 tháng) thuộc `partition_owner`, không grant; tập definer chính xác; không bảng partitioned nào tham chiếu `organizations` (R-X27) hay bảng thường nào (R-X33).
- `webhooks-down.spec.ts`: ba ca (M4).
- `normalization-inventory.spec.ts`, `constraints.spec.ts`: mọi ca.

Đỏ ở bước down (`cannot drop table webhook_endpoints because other objects depend on it`) → sai thứ tự `down`. Sửa đúng thứ tự trên, không thêm `CASCADE`.

- [ ] **Step 5: Hồi quy seed của mọi test**

Run: `pnpm test:int`
Expected: PASS; mọi `seedOrg().dispose()` của 3A–4B chạy thêm năm câu `DELETE` trên bảng webhook (0 dòng) mà không lỗi.

- [ ] **Step 6: Nhánh "6A đã merge" (chỉ khi Task 1 Step 1 in ra event `files.*` có `webhook: true`)**

Spec §17 Bảng 4: plan merge sau trong cặp 6A/6C mang dòng catalog của event files. Không áp (6A chưa merge) → bỏ qua; 6A mang migration này khi merge sau.

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/integrations --name webhook_file_events`

Nội dung (tên lớp do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Spec SP6 §17 Bảng 4, §6.10 dòng "6A∥6C": dòng catalog cho hai event files có `webhook: true` (6A khai cờ). Khoá
 * `ROW EXCLUSIVE` trên `webhook_event_types`. Down bị FK RESTRICT chặn khi còn endpoint đăng ký (runbook: gỡ đăng ký trước).
 */
export class Migration20261007000100_webhook_file_events extends Migration {
  override name = 'Migration20261007000100_webhook_file_events';
  override up(): void | Promise<void> {
    this.addSql(`INSERT INTO webhook_event_types (type) VALUES ('files.file.ready'), ('files.file.deleted');`);
  }
  override down(): void | Promise<void> {
    this.addSql(`DELETE FROM webhook_event_types WHERE type IN ('files.file.ready', 'files.file.deleted');`);
  }
}
```
Thêm vào `constraints.spec.ts`:
```ts
  it('6A merged first: the catalogue also holds files.file.ready and files.file.deleted (spec §17 Bảng 4)', async () => {
    const rows = await ownerQuery<{ type: string }>(`SELECT type FROM webhook_event_types WHERE type LIKE 'files.%' ORDER BY type`);
    expect(rows.map((r) => r.type)).toEqual(['files.file.deleted', 'files.file.ready']);
  });
```
Chạy lại Step 4.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/migrations/integrations src/modules/integrations/infra/sql/integrations-purge.sql.ts test/support/core-catalog.ts test/support/tenancy-seed.ts test/support/integrations-seed.ts test/integration/integrations/constraints.spec.ts test/integration/integrations/webhooks-down.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git add src/migrations/integrations src/modules/integrations/infra/sql/integrations-purge.sql.ts test/support/core-catalog.ts test/support/tenancy-seed.ts test/support/integrations-seed.ts test/integration/integrations/constraints.spec.ts test/integration/integrations/webhooks-down.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git commit -m "feat(integrations): webhook schema with two partitioned tables owned by partition_owner, maintenance and sweep definer functions, webhooks.* permissions"
```

---

### Task 3: Hành vi DB — cô lập RLS 5 bảng tenant (W-42), bảo trì partition (W-44, R6-17), hàm quét (C-8b với hàm thật)

**Files:**
- Create: `test/integration/integrations/isolation.spec.ts`, `test/integration/integrations/partitions.spec.ts`, `test/integration/integrations/orgs-due.spec.ts`
- Modify: `test/support/integrations-seed.ts`

**Interfaces:**
- Consumes: migration Task 2; `inOrg`, `insertEndpoint`, `insertMessage`, `insertDelivery`, `FAKE_SECRET_ENC` (Task 2); `seedOrg`, `withAppClient` (3A); `getInfra`; `PURGE_CURSOR_START` (`core/sweep`).
- Produces: bằng chứng tiêu chí 1 của spec cho năm bảng tenant của 6C; bằng chứng W-44, R6-17 trên hàm thật; hồi quy của `integrations_orgs_due` (C-8b). `org-sweep-signatures.spec.ts` của 6.0 tự phủ chữ ký hàm quét khi Task 5 đăng ký sweep.
  - `orphanDeliveries(orgId): Promise<number>` (thêm vào `test/support/integrations-seed.ts`): số delivery của org không có dòng endpoint — câu kiểm bất biến R-X33, dùng lại ở test sweep xoá cứng (Task 11), race fan-out ↔ xoá cứng (Task 11) và purge (Task 15).

- [ ] **Step 1: Test cô lập (W-42)**

`test/integration/integrations/isolation.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  FAKE_SECRET_ENC, inOrg, insertDelivery, insertEndpoint, insertMessage, orgQuery, orphanDeliveries, type SeededEndpoint, type SeededMessage,
} from '../../support/integrations-seed.js';
import { seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Năm bảng tenant của 6C (spec SP6 tiêu chí 1). */
const TABLES = ['webhook_endpoints', 'webhook_endpoint_secrets', 'webhook_endpoint_event_types', 'webhook_messages', 'webhook_deliveries'] as const;
/** Bảng mà `app_user` được UPDATE `updated_at` (messages và event_types không có grant UPDATE). */
const UPDATABLE = new Set<string>(['webhook_endpoints', 'webhook_endpoint_secrets', 'webhook_deliveries']);

describe('tenant isolation of the webhook tables (spec SP6 criterion 1, W-42)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let seededB: { endpoint: SeededEndpoint; message: SeededMessage };
  const countsOf = (orgId: string) =>
    inOrg(orgId, async (c) => {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n ?? -1;
      return out;
    });
  beforeAll(async () => {
    applyTestEnv();
    a = await seedOrg();
    b = await seedOrg();
    seededB = await inOrg(b.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, b.orgId);
      await c.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`, [b.orgId, endpoint.id, FAKE_SECRET_ENC]);
      const message = await insertMessage(c, b.orgId);
      await insertDelivery(c, b.orgId, { endpoint, message });
      return { endpoint, message };
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  it.each(TABLES)('%s: read, update and delete of org B from org A touch 0 rows', async (table) => {
    const before = await countsOf(b.orgId);
    expect(before[table]).toBeGreaterThan(0);
    await inOrg(a.orgId, async (c) => {
      expect((await c.query(`SELECT 1 FROM ${table} WHERE org_id = $1`, [b.orgId])).rowCount).toBe(0);
      if (UPDATABLE.has(table))
        expect((await c.query(`UPDATE ${table} SET updated_at = now() WHERE org_id = $1`, [b.orgId])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM ${table} WHERE org_id = $1`, [b.orgId])).rowCount).toBe(0);
    });
    expect(await countsOf(b.orgId)).toEqual(before);
  });
  it('an INSERT carrying org B from org A is refused by RLS (42501), on a plain and on a partitioned table', async () => {
    await expect(
      inOrg(a.orgId, (c) => c.query(`INSERT INTO webhook_endpoints (org_id, url) VALUES ($1, 'https://hooks.example.test/x')`, [b.orgId])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inOrg(a.orgId, (c) =>
        c.query(`INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body) VALUES ($1, $2, 'tenancy.org.updated', 1, '{}')`, [
          b.orgId,
          v7(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('without an org context every webhook table fails closed (P0001)', async () => {
    for (const t of TABLES) await expect(withAppClient((c) => c.query(`SELECT 1 FROM ${t}`))).rejects.toMatchObject({ code: 'P0001' });
  });
  it('the double FK refuses to attach org A rows to an endpoint or message of org B (23503)', async () => {
    await expect(
      inOrg(a.orgId, (c) =>
        c.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`, [a.orgId, seededB.endpoint.id, FAKE_SECRET_ENC]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inOrg(a.orgId, async (c) => insertDelivery(c, a.orgId, { endpoint: await insertEndpoint(c, a.orgId), message: seededB.message })),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('app_user cannot read a partition directly (42501)', async () => {
    const now = new Date();
    const partition = `webhook_deliveries_p${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(withAppClient((c) => c.query(`SELECT 1 FROM ${partition}`))).rejects.toMatchObject({ code: '42501' });
  });
});
```
`test/support/integrations-seed.ts`: thêm
```ts
/**
 * Bất biến R-X33 "mọi delivery có endpoint": DB không ép (không FK partitioned → bảng thường), nên mọi test chạm đường
 * ghi delivery hoặc xoá cứng endpoint gọi hàm này và đòi `0`.
 */
export async function orphanDeliveries(orgId: string): Promise<number> {
  const [r] = await orgQuery<{ n: number }>(
    orgId,
    `SELECT count(*)::int AS n FROM webhook_deliveries d
     WHERE NOT EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.org_id = d.org_id AND e.id = d.endpoint_id)`,
  );
  if (r === undefined) throw new Error('orphanDeliveries: count returned no row');
  return r.n;
}
```
`test/integration/integrations/isolation.spec.ts` (khối trên đã import `orgQuery`, `orphanDeliveries`): thêm ca
```ts
  it('R-X33 invariant: every delivery has its endpoint, and the check really sees an orphan', async () => {
    expect(await orphanDeliveries(b.orgId)).toBe(0);
    // Không FK: một DELETE trần (không qua sweep) để lại delivery mồ côi — chứng minh câu kiểm không rỗng tình cờ, rồi dọn.
    const stray = await inOrg(b.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, b.orgId);
      const message = await insertMessage(c, b.orgId);
      const d = await insertDelivery(c, b.orgId, { endpoint, message });
      await c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [endpoint.id]);
      return d;
    });
    expect(await orphanDeliveries(b.orgId)).toBe(1);
    await orgQuery(b.orgId, `DELETE FROM webhook_deliveries WHERE public_id = $1`, [stray.publicId]);
    expect(await orphanDeliveries(b.orgId)).toBe(0);
  });
```
Đường ghi/xoá thật giữ bất biến này được test ở Task 11 (sweep xoá cứng, race fan-out ↔ xoá cứng) và Task 15 (purge).

Run: `pnpm vitest run --project integration test/integration/integrations/isolation.spec.ts`
Expected: PASS ngay (schema có từ Task 2). RED trước: chạy một lần sau khi tạm `ALTER POLICY webhook_deliveries_tenant ON webhook_deliveries USING (true)` bằng owner → ca đầu của `webhook_deliveries` đỏ; hoàn nguyên `ALTER POLICY webhook_deliveries_tenant ON webhook_deliveries USING (org_id = app_current_org())`. Ghi vào báo cáo task.

- [ ] **Step 2: Test bảo trì partition (W-44, R6-17)**

`test/integration/integrations/partitions.spec.ts` (DB dùng chung, mẫu `test/integration/core/partitions/partition-maintain.spec.ts` của 6.0: chỉ gắn/gỡ tháng **quá khứ**, dọn bản sót của lần chạy trước):
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { inOrg, insertDelivery, insertEndpoint, insertMessage } from '../../support/integrations-seed.js';
import { seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const TABLES = ['webhook_messages', 'webhook_deliveries'] as const;
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const hi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { tag: `${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`, lo: lo.toISOString(), hi: hi.toISOString() };
};

describe('webhook_partitions_maintain (spec SP6 §6.7, W-44, R6-17)', () => {
  let owner: pg.Client;
  let org: SeededOrg;
  const asPartitionOwner = async (statements: string[]) => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE partition_owner');
      for (const s of statements) await owner.query(s);
      await owner.query('RESET ROLE');
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    }
  };
  const partitions = async (table: string) =>
    (
      await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`,
        [`public.${table}`],
      )
    ).rows.map((r) => r.name);
  /** Gỡ partition tháng quá khứ nếu còn (deliveries trước messages, P2). */
  const detachPast = async (offset: number) => {
    for (const t of ['webhook_deliveries', 'webhook_messages']) {
      const name = `${t}_p${month(offset).tag}`;
      const { rows } = await owner.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${name}`]);
      if (rows[0]?.present) await asPartitionOwner([`ALTER TABLE public.${t} DETACH PARTITION public.${name}`, `DROP TABLE public.${name}`]);
    }
  };
  const attachPast = async (offset: number) => {
    await detachPast(offset);
    const m = month(offset);
    await asPartitionOwner(
      TABLES.flatMap((t) => [
        `CREATE TABLE public.${t}_p${m.tag} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
        `ALTER TABLE public.${t} ATTACH PARTITION public.${t}_p${m.tag} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
      ]),
    );
  };
  const maintain = (c: pg.Client, retention: number | null, premake: number | null) =>
    c.query<{ action: string; partition_name: string }>('SELECT action, partition_name FROM webhook_partitions_maintain($1, $2)', [retention, premake]);

  beforeAll(async () => {
    applyTestEnv();
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
    org = await seedOrg();
  });
  afterAll(async () => {
    for (const o of [-6, -5, -4, -3]) await detachPast(o);
    await org?.dispose();
    await owner?.end();
  });

  it('the migration made the current month and three months ahead for both tables; a rerun is a no-op', async () => {
    for (const t of TABLES) for (const i of [0, 1, 2, 3]) expect(await partitions(t)).toContain(`${t}_p${month(i).tag}`);
    expect((await withAppClient((c) => maintain(c, 1, 3))).rows).toEqual([]);
  });
  it('drops expired months deliveries first, keeps the month at the boundary, and the rows go with them (W-44)', async () => {
    await attachPast(-4);
    await attachPast(-3);
    await inOrg(org.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, org.orgId);
      const message = await insertMessage(c, org.orgId, { createdAt: month(-4).lo });
      await insertDelivery(c, org.orgId, { endpoint, message });
    });
    // retention 3: cutoff = đầu tháng -3; tháng -4 hết hạn trọn, tháng -3 (biên) còn.
    const res = await withAppClient((c) => maintain(c, 3, 3));
    expect(res.rows).toEqual([
      { action: 'dropped', partition_name: `webhook_deliveries_p${month(-4).tag}` },
      { action: 'dropped', partition_name: `webhook_messages_p${month(-4).tag}` },
    ]);
    for (const t of TABLES) expect(await partitions(t)).toContain(`${t}_p${month(-3).tag}`);
  });
  it.each([
    [0, 3, /p_retention_months must be between 1 and 120/],
    [121, 3, /p_retention_months must be between 1 and 120/],
    [1, 0, /p_premake_months must be between 1 and 12/],
    [null, 3, /must not be NULL/],
  ])('refuses retention %s / premake %s even when called directly', async (r, p, re) => {
    await expect(withAppClient((c) => maintain(c, r, p))).rejects.toThrow(re);
  });
  it('a second concurrent run is a no-op while the first holds advisory lock 6002 (R6-17)', async () => {
    await attachPast(-5);
    await withAppClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock(6002)');
        expect((await withAppClient((c) => maintain(c, 3, 3))).rows).toEqual([]);
      } finally {
        await holder.query('ROLLBACK');
      }
    });
    expect((await withAppClient((c) => maintain(c, 3, 3))).rows.map((r) => r.partition_name)).toEqual([
      `webhook_deliveries_p${month(-5).tag}`,
      `webhook_messages_p${month(-5).tag}`,
    ]);
  });
  it('an unexpected partition name makes the run fail loud', async () => {
    const m = month(-6);
    await asPartitionOwner([
      `CREATE TABLE public.webhook_messages_odd (LIKE public.webhook_messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.webhook_messages ATTACH PARTITION public.webhook_messages_odd FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
    ]);
    try {
      await expect(withAppClient((c) => maintain(c, 3, 3))).rejects.toThrow(/unexpected partition webhook_messages_odd/);
    } finally {
      await asPartitionOwner([`ALTER TABLE public.webhook_messages DETACH PARTITION public.webhook_messages_odd`, `DROP TABLE public.webhook_messages_odd`]);
    }
  });
  it('one run over both tables with drops finishes inside the app_user statement_timeout (ADR 0020 P1 budget)', async () => {
    await attachPast(-4);
    const t0 = performance.now();
    await withAppClient((c) => maintain(c, 3, 3));
    const ms = performance.now() - t0;
    process.stdout.write(`${JSON.stringify({ event: 'webhook_partitions_maintain_ms', ms: Math.round(ms) })}\n`);
    expect(ms).toBeLessThan(5000);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/integrations/partitions.spec.ts`
Expected: PASS; số đo `webhook_partitions_maintain_ms` ghi vào báo cáo task (Task 19 chép vào ADR 0020: P1 đòi 6C so thời gian một lượt hai bảng với ngân sách `statement_timeout`).

- [ ] **Step 3: Test hàm quét**

`test/integration/integrations/orgs-due.spec.ts`:
```ts
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURGE_CURSOR_START } from '../../../src/core/sweep/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { inOrg, insertDelivery, insertEndpoint, insertMessage } from '../../support/integrations-seed.js';
import { seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const GRACE_SEC = 60;
const due = (after: string, limit: number, grace: number) =>
  withAppClient((c) =>
    c.query<{ org_id: string }>('SELECT org_id FROM integrations_orgs_due(p_after => $1::uuid, p_limit => $2::integer, p_grace_sec => $3::integer)', [
      after,
      limit,
      grace,
    ]),
  );

describe('integrations_orgs_due (spec SP6 §6.8, R-X14)', () => {
  const orgs: SeededOrg[] = [];
  const mine = new Map<string, string>();
  const seedWith = async (label: string, fn: (c: pg.Client, orgId: string) => Promise<void>) => {
    const o = await seedOrg();
    orgs.push(o);
    mine.set(label, o.orgId);
    await inOrg(o.orgId, (c) => fn(c, o.orgId));
  };
  const delivery = async (c: pg.Client, orgId: string) => {
    const endpoint = await insertEndpoint(c, orgId);
    return insertDelivery(c, orgId, { endpoint, message: await insertMessage(c, orgId) });
  };
  beforeAll(async () => {
    applyTestEnv();
    await seedWith('overdue', async (c, id) => {
      const d = await delivery(c, id);
      await c.query(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 hour' WHERE public_id = $1`, [d.publicId]);
    });
    await seedWith('leased', async (c, id) => {
      const d = await delivery(c, id);
      await c.query(
        `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 1, lease_until = now() - interval '1 hour' WHERE public_id = $1`,
        [d.publicId],
      );
    });
    await seedWith('purgeable', async (c, id) => {
      const e = await insertEndpoint(c, id);
      await c.query(`UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [e.id]);
    });
    await seedWith('fresh', async (c, id) => {
      await delivery(c, id);
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
  });

  it('returns orgs with overdue work, expired leases or endpoints due for hard delete, ascending, distinct; not the fresh one', async () => {
    const got = (await due(PURGE_CURSOR_START, 1000, GRACE_SEC)).rows.map((r) => r.org_id);
    const ours = got.filter((id) => [...mine.values()].includes(id));
    expect(ours).toEqual([mine.get('overdue'), mine.get('leased'), mine.get('purgeable')].sort());
    expect(ours).not.toContain(mine.get('fresh'));
    expect([...got].sort()).toEqual(got);
    expect(new Set(got).size).toBe(got.length);
  });
  it('keyset: p_after skips earlier orgs and p_limit caps the batch', async () => {
    const first = (await due(PURGE_CURSOR_START, 1, GRACE_SEC)).rows;
    expect(first).toHaveLength(1);
    const after = first[0]?.org_id ?? PURGE_CURSOR_START;
    expect((await due(after, 1000, GRACE_SEC)).rows.map((r) => r.org_id)).not.toContain(after);
  });
  it.each([
    [0, GRACE_SEC, /p_limit must be between 1 and 1000/],
    [1001, GRACE_SEC, /p_limit must be between 1 and 1000/],
    [10, 0, /p_grace_sec must be between 1 and 86400/],
    [10, 86_401, /p_grace_sec must be between 1 and 86400/],
  ])('refuses p_limit %i / p_grace_sec %i', async (limit, grace, re) => {
    await expect(due(PURGE_CURSOR_START, limit, grace)).rejects.toThrow(re);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/integrations/orgs-due.spec.ts`
Expected: PASS. RED: chạy trước Task 2 Step 3 → `function integrations_orgs_due(...) does not exist`; ghi vào báo cáo.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/integration/integrations
git add test/integration/integrations/isolation.spec.ts test/integration/integrations/partitions.spec.ts test/integration/integrations/orgs-due.spec.ts
git commit -m "test(integrations): RLS isolation of the webhook tables, partition maintenance drop order and floor, orgs-due sweep function"
```

---

## Phần C — Miền thuần và khung module (spec §7.2–§7.4, §5.1, §5.3, §9.1, §10, §11.4)

### Task 4: Miền thuần — máy trạng thái delivery và `classifyAttempt`, lịch retry, máy trạng thái endpoint, body webhook, phân loại kết quả HTTP (W-34 phần unit)

**Files:**
- Create: `src/modules/integrations/constants.ts`, `src/modules/integrations/domain/webhook-delivery.ts`, `src/modules/integrations/domain/retry-schedule.ts`, `src/modules/integrations/domain/webhook-endpoint.ts`, `src/modules/integrations/domain/webhook-payload.ts`, `src/modules/integrations/domain/attempt-outcome.ts`, `test/unit/modules/integrations/webhook-delivery.spec.ts`, `test/unit/modules/integrations/retry-schedule.spec.ts`, `test/unit/modules/integrations/webhook-endpoint.spec.ts`, `test/unit/modules/integrations/webhook-payload.spec.ts`, `test/unit/modules/integrations/attempt-outcome.spec.ts`

**Interfaces:**
- Consumes: `UpstreamError`, `SsrfBlockedError`, `type UpstreamFailure` (`core/resilience`, `upstream-error.ts:10-17`; `domain-pure` cấm `infra`/`http`/ORM, không cấm core); `EventActor` (`core/events`).
- Produces (Task 6–15 dùng đúng tên):
  - `constants.ts`: `WEBHOOK_EVENT_TYPES_MAX = 50` (M7), `WEBHOOK_SECRET_BYTES = 32`, `WEBHOOK_SECRET_PREFIX = 'whsec_'`, `WEBHOOK_URL_MIN_LENGTH = 10`, `WEBHOOK_URL_MAX_LENGTH = 2048`, `WEBHOOK_DESCRIPTION_MAX_LENGTH = 500`, `WEBHOOK_EVENT_TYPE_PATTERN`, `WEBHOOK_PARTITIONS_LOCK_KEY = 6002n`, `WEBHOOK_RETENTION_MIN_MONTHS = 1`, `INTEGRATIONS_PURGE_ORDER = 120`, `WEBHOOKS_OUT = 'webhooks-out'`, `WEBHOOK_BREAKER_NEVER = Number.MAX_SAFE_INTEGER`, `CLAIM_CLOCK_SKEW_MS = 1000`, `WEBHOOK_USER_AGENT_SUFFIX = '-webhooks/1'`, `INTEGRATIONS_SYSTEM_ACTOR: EventActor`, `ENDPOINT_AGGREGATE = 'webhook_endpoint'`, `DELIVERY_AGGREGATE = 'webhook_delivery'`.
  - `domain/webhook-delivery.ts`: `DELIVERY_STATUSES`, `type DeliveryStatus`, `TERMINAL_DELIVERY_STATUSES`, `LAST_ERRORS`, `type LastError`, `type AttemptError = Exclude<LastError, 'ENDPOINT_UNAVAILABLE'>`, `ATTEMPT_ERRORS`, `type Blame = 'ENDPOINT' | 'LOCAL'`, `classifyAttempt(error: AttemptError): Blame`, `localRetryLeft(localFailuresBefore, max): boolean` (R-X35), `type DeliveryEvent` (thêm `DEFER`: kill switch và từ chối claim vì bulkhead in-flight), `type DeliveryEffect` (thêm `localFailures: 'KEEP' | 'INCREMENT' | 'RESET'`), `transitionDelivery(from, event)`, `isTerminalDelivery(status)`.
  - `domain/retry-schedule.ts`: `RETRY_JITTER_RATIO = 0.1`, `scheduledDelaySec(schedule, attemptInCycle): number | undefined`, `jitteredMs(sec, random): number`, `retryDelayMs({ scheduleSec, retryAfterSec, random }): number`.
  - `domain/webhook-endpoint.ts`: `ENDPOINT_STATUSES`, `type EndpointStatus`, `DISABLED_REASONS`, `type DisabledReason`, `type EndpointState`, `type EndpointEvent`, `transitionEndpoint(from, event)`, `urlHost(url): string`.
  - `domain/webhook-payload.ts`: `WEBHOOK_BODY_MAX_BYTES = 262144`, `WEBHOOK_TEST_EVENT_TYPE = 'webhook.test'`, `WEBHOOK_TEST_EVENT_VERSION = 1`, `type WebhookPayload`, `buildWebhookBody(p): { kind: 'OK'; body: string } | { kind: 'TOO_LARGE'; bytes: number }`.
  - `domain/attempt-outcome.ts`: `type AttemptOutcome = { kind: 'DELIVERED'; statusCode: number } | { kind: 'FAILED'; error: AttemptError; statusCode: number | null; retryAfterSec: number | null }`, `outcomeOfStatus(statusCode): AttemptOutcome`, `outcomeOfError(err: unknown): AttemptOutcome` (lỗi không phải `UpstreamError`/`SsrfBlockedError` → ném lại: là bug).

- [ ] **Step 1: Unit test (fail)**

`test/unit/modules/integrations/webhook-delivery.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ERRORS, DELIVERY_STATUSES, LAST_ERRORS, TERMINAL_DELIVERY_STATUSES, classifyAttempt, isTerminalDelivery, localRetryLeft,
  transitionDelivery, type DeliveryEvent, type DeliveryStatus,
} from '../../../../src/modules/integrations/domain/webhook-delivery.js';

const EVENTS: readonly DeliveryEvent[] = [
  { kind: 'CLAIM', endpointAvailable: true },
  { kind: 'CLAIM', endpointAvailable: false },
  { kind: 'DEFER' },
  { kind: 'DELIVERED' },
  { kind: 'FAILED', blame: 'ENDPOINT', retryLeft: true },
  { kind: 'FAILED', blame: 'ENDPOINT', retryLeft: false },
  { kind: 'FAILED', blame: 'LOCAL', retryLeft: true },
  { kind: 'FAILED', blame: 'LOCAL', retryLeft: false },
  { kind: 'REQUEUE' },
];
/**
 * Bảng chuyển của spec §7.2 + R-X35: `from|event → to,attemptsTotal,cycleBase,localFailures`; ô không có là bị từ chối.
 * `retryLeft` của ENDPOINT = còn bước lịch; của LOCAL = `localRetryLeft(local_failures, INTEGRATIONS_MAX_LOCAL_FAILURES)`.
 */
const ALLOWED: Record<string, string> = {
  'PENDING|CLAIM:true': 'SENDING,INCREMENT,KEEP,KEEP',
  'RETRY_SCHEDULED|CLAIM:true': 'SENDING,INCREMENT,KEEP,KEEP',
  'PENDING|CLAIM:false': 'CANCELLED,INCREMENT,KEEP,KEEP',
  'RETRY_SCHEDULED|CLAIM:false': 'CANCELLED,INCREMENT,KEEP,KEEP',
  'PENDING|DEFER': 'PENDING,KEEP,KEEP,KEEP',
  'RETRY_SCHEDULED|DEFER': 'RETRY_SCHEDULED,KEEP,KEEP,KEEP',
  'SENDING|DELIVERED': 'SUCCEEDED,KEEP,KEEP,KEEP',
  'SENDING|FAILED:ENDPOINT:true': 'RETRY_SCHEDULED,KEEP,KEEP,KEEP',
  'SENDING|FAILED:ENDPOINT:false': 'EXHAUSTED,KEEP,KEEP,KEEP',
  'SENDING|FAILED:LOCAL:true': 'RETRY_SCHEDULED,KEEP,INCREMENT,INCREMENT',
  'SENDING|FAILED:LOCAL:false': 'EXHAUSTED,KEEP,INCREMENT,INCREMENT',
  'SUCCEEDED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
  'EXHAUSTED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
  'CANCELLED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
};
const label = (e: DeliveryEvent): string => {
  switch (e.kind) {
    case 'CLAIM':
      return `CLAIM:${e.endpointAvailable}`;
    case 'FAILED':
      return `FAILED:${e.blame}:${e.retryLeft}`;
    case 'DEFER':
    case 'DELIVERED':
    case 'REQUEUE':
      return e.kind;
  }
};
const CELLS = DELIVERY_STATUSES.flatMap((s) => EVENTS.map((e) => [s, e] as const));

describe('webhook delivery state machine (spec SP6 §7.2)', () => {
  it.each(CELLS)('%s × %j', (from: DeliveryStatus, e: DeliveryEvent) => {
    const t = transitionDelivery(from, e);
    const want = ALLOWED[`${from}|${label(e)}`];
    if (want === undefined) expect(t).toEqual({ ok: false });
    else expect(t.ok ? `${t.effect.to},${t.effect.attemptsTotal},${t.effect.cycleBase},${t.effect.localFailures}` : 'refused').toBe(want);
  });
  it.each([
    [0, 5, true],
    [3, 5, true],
    [4, 5, false],
    [0, 1, false],
  ])('R-X35: localRetryLeft(%i failures before, max %i) = %s (the max-th local failure exhausts)', (before, max, want) => {
    expect(localRetryLeft(before, max)).toBe(want);
  });
  it.each([
    [-1, 5],
    [0, 0],
    [1.5, 5],
  ])('localRetryLeft refuses (%d, %d)', (before, max) => {
    expect(() => localRetryLeft(before, max)).toThrow(/localRetryLeft/);
  });
  it('terminal statuses are exactly SUCCEEDED, EXHAUSTED and CANCELLED', () => {
    expect(DELIVERY_STATUSES.filter(isTerminalDelivery)).toEqual([...TERMINAL_DELIVERY_STATUSES]);
    expect(TERMINAL_DELIVERY_STATUSES).toEqual(['SUCCEEDED', 'EXHAUSTED', 'CANCELLED']);
  });
});

describe('classifyAttempt (spec SP6 §7.2, S6-A49, W-34)', () => {
  it('covers every last_error except ENDPOINT_UNAVAILABLE, which is a claim branch, never an attempt', () => {
    expect([...ATTEMPT_ERRORS].sort()).toEqual(LAST_ERRORS.filter((e) => e !== 'ENDPOINT_UNAVAILABLE').sort());
  });
  it.each([
    ['TIMEOUT', 'ENDPOINT'],
    ['NETWORK', 'ENDPOINT'],
    ['SERVER_ERROR', 'ENDPOINT'],
    ['CLIENT_ERROR', 'ENDPOINT'],
    ['REDIRECT', 'ENDPOINT'],
    ['RATE_LIMITED', 'ENDPOINT'],
    ['SSRF_BLOCKED', 'ENDPOINT'],
    ['TOO_LARGE', 'ENDPOINT'],
    ['BULKHEAD_FULL', 'LOCAL'],
    ['CIRCUIT_OPEN', 'LOCAL'],
    ['LEASE_EXPIRED', 'LOCAL'],
    ['SECRET_UNAVAILABLE', 'LOCAL'],
  ] as const)('%s is the fault of the %s', (error, blame) => {
    expect(classifyAttempt(error)).toBe(blame);
  });
  it('the table above covers every attempt error (a missing value in the source is a compile error)', () => {
    expect(ATTEMPT_ERRORS).toHaveLength(12);
  });
});
```
`test/unit/modules/integrations/retry-schedule.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RETRY_JITTER_RATIO, jitteredMs, retryDelayMs, scheduledDelaySec } from '../../../../src/modules/integrations/domain/retry-schedule.js';

const SCHEDULE = [5, 300, 1800];
const low = () => 0;
const mid = () => 0.5;
const high = () => 0.999_999;

describe('retry schedule (spec SP6 §7.2, §11.4)', () => {
  it('attempt n of the cycle waits schedule[n-1]; a schedule of k steps allows k+1 attempts', () => {
    expect(scheduledDelaySec(SCHEDULE, 1)).toBe(5);
    expect(scheduledDelaySec(SCHEDULE, 3)).toBe(1800);
    expect(scheduledDelaySec(SCHEDULE, 4)).toBeUndefined();
  });
  it.each([0, -1, 1.5])('refuses attempt %d', (n) => {
    expect(() => scheduledDelaySec(SCHEDULE, n)).toThrow(/attemptInCycle/);
  });
  it('jitter stays within ±10% and is integer milliseconds', () => {
    expect(jitteredMs(100, mid)).toBe(100_000);
    expect(jitteredMs(100, low)).toBe(100_000 * (1 - RETRY_JITTER_RATIO));
    expect(jitteredMs(100, high)).toBeLessThanOrEqual(100_000 * (1 + RETRY_JITTER_RATIO));
    expect(Number.isInteger(jitteredMs(7, high))).toBe(true);
  });
  it.each([-0.1, 1, Number.NaN])('refuses a random value %d outside [0, 1)', (r) => {
    expect(() => jitteredMs(5, () => r)).toThrow(/random/);
  });
  it('Review Focus 3: Retry-After is a floor over the jittered schedule; absent or zero leaves the schedule', () => {
    expect(retryDelayMs({ scheduleSec: 5, retryAfterSec: 30, random: mid })).toBe(30_000);
    expect(retryDelayMs({ scheduleSec: 60, retryAfterSec: 30, random: mid })).toBe(60_000);
    expect(retryDelayMs({ scheduleSec: 5, retryAfterSec: null, random: mid })).toBe(5_000);
    expect(retryDelayMs({ scheduleSec: 5, retryAfterSec: 0, random: mid })).toBe(5_000);
  });
});
```
`test/unit/modules/integrations/webhook-endpoint.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { transitionEndpoint, urlHost, type EndpointEvent, type EndpointState } from '../../../../src/modules/integrations/domain/webhook-endpoint.js';

const ACTIVE: EndpointState = { status: 'ACTIVE' };
const MANUAL: EndpointState = { status: 'DISABLED', reason: 'MANUAL' };
const AUTO: EndpointState = { status: 'DISABLED', reason: 'AUTO_FAILING' };
const E = (kind: EndpointEvent['kind']): EndpointEvent => ({ kind });

describe('webhook endpoint state machine (spec SP6 §7.3)', () => {
  it.each([
    [ACTIVE, 'DISABLE', { kind: 'CHANGED', to: MANUAL }],
    [ACTIVE, 'AUTO_DISABLE', { kind: 'CHANGED', to: AUTO }],
    [ACTIVE, 'ENABLE', { kind: 'UNCHANGED' }],
    [MANUAL, 'ENABLE', { kind: 'CHANGED', to: ACTIVE }],
    [AUTO, 'ENABLE', { kind: 'CHANGED', to: ACTIVE }],
    [MANUAL, 'DISABLE', { kind: 'UNCHANGED' }],
    [AUTO, 'DISABLE', { kind: 'UNCHANGED' }],
    [MANUAL, 'AUTO_DISABLE', { kind: 'UNCHANGED' }],
    [AUTO, 'AUTO_DISABLE', { kind: 'UNCHANGED' }],
  ] as const)('%j × %s', (from, kind, want) => {
    expect(transitionEndpoint(from, E(kind))).toEqual(want);
  });
  it('urlHost keeps only the host (path, query and credentials never reach an event)', () => {
    expect(urlHost('https://hooks.example.test:8443/a/b?token=secret')).toBe('hooks.example.test');
    expect(urlHost('https://[2001:db8::1]/x')).toBe('[2001:db8::1]');
  });
});
```
`test/unit/modules/integrations/webhook-payload.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WEBHOOK_BODY_MAX_BYTES, buildWebhookBody } from '../../../../src/modules/integrations/domain/webhook-payload.js';

describe('webhook body (spec SP6 §8.3 fan-out step 3)', () => {
  it('serialises { type, version, timestamp, data } exactly once, in that key order', () => {
    expect(
      buildWebhookBody({ type: 'tenancy.org.updated', version: 1, timestamp: '2026-10-01T00:00:00.000Z', data: { orgId: 'o', changed: ['name'] } }),
    ).toEqual({
      kind: 'OK',
      body: '{"type":"tenancy.org.updated","version":1,"timestamp":"2026-10-01T00:00:00.000Z","data":{"orgId":"o","changed":["name"]}}',
    });
  });
  it('measures UTF-8 bytes, not UTF-16 units, against WEBHOOK_BODY_MAX_BYTES', () => {
    const r = buildWebhookBody({ type: 't.a.b', version: 1, timestamp: 'x', data: { emoji: '😀'.repeat(WEBHOOK_BODY_MAX_BYTES / 4) } });
    expect(r.kind).toBe('TOO_LARGE');
    expect(r.kind === 'TOO_LARGE' && r.bytes > WEBHOOK_BODY_MAX_BYTES).toBe(true);
  });
});
```
`test/unit/modules/integrations/attempt-outcome.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SsrfBlockedError, UpstreamError, type UpstreamFailure } from '../../../../src/core/resilience/index.js';
import { outcomeOfError, outcomeOfStatus } from '../../../../src/modules/integrations/domain/attempt-outcome.js';

describe('HTTP result → last_error (spec SP6 §8.3 step 4)', () => {
  it.each([
    [200, { kind: 'DELIVERED', statusCode: 200 }],
    [204, { kind: 'DELIVERED', statusCode: 204 }],
    [302, { kind: 'FAILED', error: 'REDIRECT', statusCode: 302, retryAfterSec: null }],
    [404, { kind: 'FAILED', error: 'CLIENT_ERROR', statusCode: 404, retryAfterSec: null }],
    [410, { kind: 'FAILED', error: 'CLIENT_ERROR', statusCode: 410, retryAfterSec: null }],
  ])('status %i', (status, want) => {
    expect(outcomeOfStatus(status)).toEqual(want);
  });
  it.each([
    ['bad_status', 503, undefined, { kind: 'FAILED', error: 'SERVER_ERROR', statusCode: 503, retryAfterSec: null }],
    ['rate_limited', 429, 30, { kind: 'FAILED', error: 'RATE_LIMITED', statusCode: 429, retryAfterSec: 30 }],
    ['rate_limited', 429, undefined, { kind: 'FAILED', error: 'RATE_LIMITED', statusCode: 429, retryAfterSec: null }],
    ['timeout', undefined, undefined, { kind: 'FAILED', error: 'TIMEOUT', statusCode: null, retryAfterSec: null }],
    ['network', undefined, undefined, { kind: 'FAILED', error: 'NETWORK', statusCode: null, retryAfterSec: null }],
    ['too_large', undefined, undefined, { kind: 'FAILED', error: 'TOO_LARGE', statusCode: null, retryAfterSec: null }],
    ['bulkhead_full', undefined, undefined, { kind: 'FAILED', error: 'BULKHEAD_FULL', statusCode: null, retryAfterSec: null }],
    ['circuit_open', undefined, undefined, { kind: 'FAILED', error: 'CIRCUIT_OPEN', statusCode: null, retryAfterSec: null }],
  ] as const)('UpstreamError %s', (reason: UpstreamFailure, status, retryAfter, want) => {
    expect(outcomeOfError(new UpstreamError('webhooks-out', reason, 'x', { status, retryAfter }))).toEqual(want);
  });
  it('SsrfBlockedError (literal or at connect) is SSRF_BLOCKED', () => {
    expect(outcomeOfError(new SsrfBlockedError('blocked'))).toEqual({ kind: 'FAILED', error: 'SSRF_BLOCKED', statusCode: null, retryAfterSec: null });
  });
  it('any other error is a bug and is thrown, never recorded as a delivery failure', () => {
    expect(() => outcomeOfError(new TypeError('boom'))).toThrow('boom');
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/integrations`
Expected: FAIL (module chưa có), trừ `standard-webhooks.contract.spec.ts`.

- [ ] **Step 2: Cài**

`src/modules/integrations/constants.ts`:
```ts
import type { EventActor } from '../../core/events/index.js';

/**
 * Hằng định dạng của 6C (spec SP6 §11.4 "Hằng định dạng", §6.5, §6.7). Migration `…_webhooks` viết cứng cùng giá trị;
 * `constants-vs-migration.spec.ts` (Task 5) so hai bên.
 */
export const WEBHOOK_SECRET_BYTES = 32;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_URL_MIN_LENGTH = 10;
export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 500;
/**
 * Trần cứng số event type của một endpoint (M7): `.max()` của schema HTTP và `maxItems` của OpenAPI dùng hằng này, nên
 * `openapi.json` không phụ thuộc env của máy export. `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT` chỉ hạ trần lúc chạy (service kiểm).
 */
export const WEBHOOK_EVENT_TYPES_MAX = 50;
/** Cùng regex với `webhook_event_types_type_ck` và `TYPE_PATTERN` của `defineEvent`. */
export const WEBHOOK_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** `pg_try_advisory_xact_lock` của `webhook_partitions_maintain` (spec §6.7; 6001 là audit, 6900/6901 là fixture 6.0). */
export const WEBHOOK_PARTITIONS_LOCK_KEY = 6002n;
/** Sàn retention viết cứng trong hàm bảo trì. */
export const WEBHOOK_RETENTION_MIN_MONTHS = 1;
/** Registry order của participant xoá cứng (R-X5, addendum 3D §A4). */
export const INTEGRATIONS_PURGE_ORDER = 120;
/** Tên provider của `ResiliencePolicies` và tên queue (spec §5.3 hàng `core/resilience`, §10). Hằng có tên, không theo tenant. */
export const WEBHOOKS_OUT = 'webhooks-out';
/** Breaker theo provider sẽ gộp endpoint của mọi khách (S6-A30): ngưỡng không bao giờ đạt. */
export const WEBHOOK_BREAKER_NEVER = Number.MAX_SAFE_INTEGER;
/**
 * Job tới sớm hơn `next_attempt_at` quá mức này là job trùng (sweep, kill switch) hoặc lệch đồng hồ Redis/DB: claim là no-op,
 * job đúng hạn của chính lần hẹn đó vẫn chạy (R6C-1). Một giây lớn hơn độ lệch đồng hồ bình thường giữa hai máy NTP.
 */
export const CLAIM_CLOCK_SKEW_MS = 1000;
/** `user-agent` = `<APP_SERVICE_NAME>` + hậu tố này (spec §11.4 `WEBHOOK_USER_AGENT`). */
export const WEBHOOK_USER_AGENT_SUFFIX = '-webhooks/1';
/** Actor của event do hệ thống gây ra (tự tắt endpoint, hết lịch). */
export const INTEGRATIONS_SYSTEM_ACTOR: EventActor = { type: 'system', id: 'integrations.deliver' };
export const ENDPOINT_AGGREGATE = 'webhook_endpoint';
export const DELIVERY_AGGREGATE = 'webhook_delivery';
```
`src/modules/integrations/domain/webhook-delivery.ts`:
```ts
/** Máy trạng thái của một delivery (spec SP6 §7.2). DB ép cùng tập bằng `webhook_deliveries_status_ck`. */
export const DELIVERY_STATUSES = ['PENDING', 'SENDING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'EXHAUSTED', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const TERMINAL_DELIVERY_STATUSES = ['SUCCEEDED', 'EXHAUSTED', 'CANCELLED'] as const satisfies readonly DeliveryStatus[];
/** Cùng tập, cùng thứ tự với `webhook_deliveries_last_error_ck` (`constants-vs-migration.spec.ts`). */
export const LAST_ERRORS = [
  'TIMEOUT',
  'NETWORK',
  'SERVER_ERROR',
  'CLIENT_ERROR',
  'REDIRECT',
  'RATE_LIMITED',
  'SSRF_BLOCKED',
  'TOO_LARGE',
  'BULKHEAD_FULL',
  'CIRCUIT_OPEN',
  'LEASE_EXPIRED',
  'SECRET_UNAVAILABLE',
  'ENDPOINT_UNAVAILABLE',
] as const;
export type LastError = (typeof LAST_ERRORS)[number];
/** `ENDPOINT_UNAVAILABLE` là nhánh `CANCELLED` lúc claim, không phải kết quả của một lần gửi. */
export type AttemptError = Exclude<LastError, 'ENDPOINT_UNAVAILABLE'>;
export const ATTEMPT_ERRORS: readonly AttemptError[] = LAST_ERRORS.filter((e): e is AttemptError => e !== 'ENDPOINT_UNAVAILABLE');
export type Blame = 'ENDPOINT' | 'LOCAL';

/**
 * S6-A49: lỗi của endpoint tiêu một bước lịch và có thể tự tắt endpoint; lỗi của ta (bulkhead, breaker, worker chết, secret
 * không giải mã được) không chạm `failing_since` và không tiêu lịch, nhưng có đếm (R-X35: lần thứ
 * `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED`). `TIMEOUT` là của endpoint: thứ tự policy bulkhead → breaker → timeout
 * (`core/resilience/policies.ts`), thời gian chờ trong hàng bulkhead không tính vào timeout.
 */
export function classifyAttempt(error: AttemptError): Blame {
  switch (error) {
    case 'TIMEOUT':
    case 'NETWORK':
    case 'SERVER_ERROR':
    case 'CLIENT_ERROR':
    case 'REDIRECT':
    case 'RATE_LIMITED':
    case 'SSRF_BLOCKED':
    case 'TOO_LARGE':
      return 'ENDPOINT';
    case 'BULKHEAD_FULL':
    case 'CIRCUIT_OPEN':
    case 'LEASE_EXPIRED':
    case 'SECRET_UNAVAILABLE':
      return 'LOCAL';
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled attempt error ${String(unreachable)}`);
    }
  }
}

/**
 * R-X35: còn được hẹn lại sau lỗi của ta này không. `localFailuresBefore` là `local_failures` lúc claim (trước lỗi này);
 * lỗi thứ `max` → `false` (`EXHAUSTED`, phát lại được). Không giới hạn thì một khoá `FieldCipher` bị retire sai hay một
 * worker chết lặp lại sẽ giữ delivery xoay vòng mãi.
 */
export function localRetryLeft(localFailuresBefore: number, max: number): boolean {
  if (!Number.isInteger(localFailuresBefore) || localFailuresBefore < 0 || !Number.isInteger(max) || max < 1)
    throw new Error(`localRetryLeft needs a non-negative integer count and a positive integer max, got (${localFailuresBefore}, ${max})`);
  return localFailuresBefore + 1 < max;
}

export type DeliveryEvent =
  | { kind: 'CLAIM'; endpointAvailable: boolean }
  /** Không claim (kill switch, hoặc endpoint đã đủ in-flight — R-X35): chỉ dời `next_attempt_at`, không đếm gì. */
  | { kind: 'DEFER' }
  | { kind: 'DELIVERED' }
  /** `retryLeft`: ENDPOINT = còn bước lịch (`scheduledDelaySec`); LOCAL = `localRetryLeft`. */
  | { kind: 'FAILED'; blame: Blame; retryLeft: boolean }
  | { kind: 'REQUEUE' };
/**
 * `attemptsTotal: INCREMENT` ở MỌI claim (kể cả nhánh `CANCELLED`): jobId `webhook-<id>-a<n>` bị tiêu đúng khi
 * `attempts_total` thành n, nên mọi lần enqueue sau dùng `a<attempts_total + 1>` chưa từng có trong Redis. `cycleBase:
 * INCREMENT` (lỗi của ta) giữ nguyên số bước lịch đã tiêu. `localFailures: INCREMENT` ở mọi lỗi của ta, `RESET` khi phát lại.
 */
export type DeliveryEffect = {
  to: DeliveryStatus;
  attemptsTotal: 'INCREMENT' | 'KEEP';
  cycleBase: 'KEEP' | 'INCREMENT' | 'RESET_TO_ATTEMPTS';
  localFailures: 'KEEP' | 'INCREMENT' | 'RESET';
};
export type DeliveryTransition = { ok: true; effect: DeliveryEffect } | { ok: false };

const REFUSED: DeliveryTransition = { ok: false };
const to = (
  s: DeliveryStatus,
  attemptsTotal: DeliveryEffect['attemptsTotal'],
  cycleBase: DeliveryEffect['cycleBase'],
  localFailures: DeliveryEffect['localFailures'] = 'KEEP',
): DeliveryTransition => ({ ok: true, effect: { to: s, attemptsTotal, cycleBase, localFailures } });

export function isTerminalDelivery(status: DeliveryStatus): boolean {
  switch (status) {
    case 'SUCCEEDED':
    case 'EXHAUSTED':
    case 'CANCELLED':
      return true;
    case 'PENDING':
    case 'SENDING':
    case 'RETRY_SCHEDULED':
      return false;
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled delivery status ${String(unreachable)}`);
    }
  }
}
const isClaimable = (s: DeliveryStatus): boolean => s === 'PENDING' || s === 'RETRY_SCHEDULED';

/** Nguồn sự thật của bảng chuyển; repository viết đúng các CAS này (mỗi CAS có `WHERE status IN (<nguồn>)`). */
export function transitionDelivery(from: DeliveryStatus, e: DeliveryEvent): DeliveryTransition {
  switch (e.kind) {
    case 'CLAIM':
      if (!isClaimable(from)) return REFUSED;
      return to(e.endpointAvailable ? 'SENDING' : 'CANCELLED', 'INCREMENT', 'KEEP');
    case 'DEFER':
      return isClaimable(from) ? to(from, 'KEEP', 'KEEP') : REFUSED;
    case 'DELIVERED':
      return from === 'SENDING' ? to('SUCCEEDED', 'KEEP', 'KEEP') : REFUSED;
    case 'FAILED':
      if (from !== 'SENDING') return REFUSED;
      if (e.blame === 'LOCAL') return to(e.retryLeft ? 'RETRY_SCHEDULED' : 'EXHAUSTED', 'KEEP', 'INCREMENT', 'INCREMENT');
      return to(e.retryLeft ? 'RETRY_SCHEDULED' : 'EXHAUSTED', 'KEEP', 'KEEP');
    case 'REQUEUE':
      return isTerminalDelivery(from) ? to('PENDING', 'KEEP', 'RESET_TO_ATTEMPTS', 'RESET') : REFUSED;
    default: {
      const unreachable: never = e;
      throw new Error(`Unhandled delivery event ${JSON.stringify(unreachable)}`);
    }
  }
}
```
`src/modules/integrations/domain/retry-schedule.ts`:
```ts
/** ±10% quanh bước lịch (spec SP6 §7.2): các delivery cùng lỗi không dồn về cùng một giây. */
export const RETRY_JITTER_RATIO = 0.1;
const MS_PER_SEC = 1000;

/** Bước lịch sau khi lần thử thứ `attemptInCycle` (tính từ 1) thất bại; `undefined` = hết lịch (k bước → k + 1 lần thử). */
export function scheduledDelaySec(schedule: readonly number[], attemptInCycle: number): number | undefined {
  if (!Number.isInteger(attemptInCycle) || attemptInCycle < 1)
    throw new Error(`attemptInCycle must be a positive integer, got ${attemptInCycle}`);
  return schedule[attemptInCycle - 1];
}

/** `sec` giây ± `RETRY_JITTER_RATIO`, ra mili giây nguyên ≥ 0; `random()` phải trong [0, 1) như `Math.random`. */
export function jitteredMs(sec: number, random: () => number): number {
  const r = random();
  if (!(r >= 0 && r < 1)) throw new Error(`random() must return a value in [0, 1), got ${r}`);
  return Math.max(0, Math.round(sec * MS_PER_SEC * (1 + (r * 2 - 1) * RETRY_JITTER_RATIO)));
}

/**
 * Trễ của lần hẹn sau lỗi của endpoint: `max(lịch có jitter, Retry-After)`. `retryAfterSec` đã được `HttpClient` chặn trần
 * `RESILIENCE_RETRY_AFTER_MAX_SEC` (`parseRetryAfterSec`), là 0 với HTTP-date đã qua; `null` khi không có header.
 */
export function retryDelayMs(o: { scheduleSec: number; retryAfterSec: number | null; random: () => number }): number {
  const scheduled = jitteredMs(o.scheduleSec, o.random);
  return o.retryAfterSec === null ? scheduled : Math.max(scheduled, o.retryAfterSec * MS_PER_SEC);
}
```
`src/modules/integrations/domain/webhook-endpoint.ts`:
```ts
/** Máy trạng thái endpoint (spec SP6 §7.3). DB ép cặp `status`/`disabled_reason` bằng `webhook_endpoints_disabled_pair_ck`. */
export const ENDPOINT_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];
export const DISABLED_REASONS = ['MANUAL', 'AUTO_FAILING'] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];
export type EndpointState = { status: 'ACTIVE' } | { status: 'DISABLED'; reason: DisabledReason };
export type EndpointEvent = { kind: 'DISABLE' } | { kind: 'ENABLE' } | { kind: 'AUTO_DISABLE' };
export type EndpointTransition = { kind: 'CHANGED'; to: EndpointState } | { kind: 'UNCHANGED' };

const UNCHANGED: EndpointTransition = { kind: 'UNCHANGED' };

/** `PATCH status` lặp lại hoặc tự tắt trên endpoint đã tắt là không đổi gì (không event, không bump version). */
export function transitionEndpoint(from: EndpointState, e: EndpointEvent): EndpointTransition {
  switch (e.kind) {
    case 'DISABLE':
      return from.status === 'ACTIVE' ? { kind: 'CHANGED', to: { status: 'DISABLED', reason: 'MANUAL' } } : UNCHANGED;
    case 'AUTO_DISABLE':
      return from.status === 'ACTIVE' ? { kind: 'CHANGED', to: { status: 'DISABLED', reason: 'AUTO_FAILING' } } : UNCHANGED;
    case 'ENABLE':
      return from.status === 'DISABLED' ? { kind: 'CHANGED', to: { status: 'ACTIVE' } } : UNCHANGED;
    default: {
      const unreachable: never = e;
      throw new Error(`Unhandled endpoint event ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Chỉ host (spec §8.3 bước 3): path/query có thể chứa token của khách, không bao giờ vào event hay log. */
export const urlHost = (url: string): string => new URL(url).hostname;
```
`src/modules/integrations/domain/webhook-payload.ts`:
```ts
/** Hằng định dạng (spec §6.5 `webhook_messages_body_ck`): body lớn hơn là lỗi thiết kế event, không gửi. */
export const WEBHOOK_BODY_MAX_BYTES = 262_144;
/** Message của `POST …/test` (spec §8.3 "Gửi thử"); `webhook_messages_event_type_ck` cho phép riêng giá trị này. */
export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';
export const WEBHOOK_TEST_EVENT_VERSION = 1;

export type WebhookPayload = { type: string; version: number; timestamp: string; data: unknown };
export type BuiltBody = { kind: 'OK'; body: string } | { kind: 'TOO_LARGE'; bytes: number };

/** Tuần tự hoá MỘT lần (spec §8.3): chính chuỗi này được lưu và ký nguyên văn ở mọi lần gửi. */
export function buildWebhookBody(p: WebhookPayload): BuiltBody {
  const body = JSON.stringify({ type: p.type, version: p.version, timestamp: p.timestamp, data: p.data });
  const bytes = Buffer.byteLength(body, 'utf8');
  return bytes > WEBHOOK_BODY_MAX_BYTES ? { kind: 'TOO_LARGE', bytes } : { kind: 'OK', body };
}
```
`src/modules/integrations/domain/attempt-outcome.ts`:
```ts
import { SsrfBlockedError, UpstreamError } from '../../../core/resilience/index.js';
import type { AttemptError } from './webhook-delivery.js';

export type AttemptOutcome =
  | { kind: 'DELIVERED'; statusCode: number }
  | { kind: 'FAILED'; error: AttemptError; statusCode: number | null; retryAfterSec: number | null };

const SUCCESS_MIN = 200;
const REDIRECT_MIN = 300;
const CLIENT_ERROR_MIN = 400;
const failed = (error: AttemptError, statusCode: number | null = null, retryAfterSec: number | null = null): AttemptOutcome => ({
  kind: 'FAILED',
  error,
  statusCode,
  retryAfterSec,
});

/**
 * Status trả về bình thường của `HttpClient` (spec §8.3 bước 4): 3xx (không theo redirect) và 4xx khác 429 không ném; 429 và
 * 5xx ném `UpstreamError` (`outcomeOfError`). 1xx không bao giờ tới đây (undici xử lý).
 */
export function outcomeOfStatus(statusCode: number): AttemptOutcome {
  if (statusCode >= SUCCESS_MIN && statusCode < REDIRECT_MIN) return { kind: 'DELIVERED', statusCode };
  if (statusCode >= REDIRECT_MIN && statusCode < CLIENT_ERROR_MIN) return failed('REDIRECT', statusCode);
  return failed('CLIENT_ERROR', statusCode);
}

/** `switch` vét cạn trên `UpstreamFailure`; lỗi khác `UpstreamError`/`SsrfBlockedError` là bug: ném lại, không ghi thành lỗi gửi. */
export function outcomeOfError(err: unknown): AttemptOutcome {
  if (err instanceof SsrfBlockedError) return failed('SSRF_BLOCKED');
  if (!(err instanceof UpstreamError)) throw err;
  const status = err.status ?? null;
  switch (err.reason) {
    case 'bad_status':
      return failed('SERVER_ERROR', status);
    case 'rate_limited':
      return failed('RATE_LIMITED', status, err.retryAfter ?? null);
    case 'timeout':
      return failed('TIMEOUT');
    case 'network':
      return failed('NETWORK');
    case 'too_large':
      return failed('TOO_LARGE');
    case 'bulkhead_full':
      return failed('BULKHEAD_FULL');
    case 'circuit_open':
      return failed('CIRCUIT_OPEN');
    default: {
      const unreachable: never = err.reason;
      throw new Error(`Unhandled upstream failure ${String(unreachable)}`);
    }
  }
}
```

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations
pnpm typecheck
pnpm arch
```
Expected: PASS. `pnpm arch` có thể cảnh báo `no-orphans` cho file domain chưa được import (mức `warn`, exit 0); Task 6–11 nối chúng.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/unit/modules/integrations
git add src/modules/integrations/constants.ts src/modules/integrations/domain test/unit/modules/integrations
git commit -m "feat(integrations): delivery and endpoint state machines, classifyAttempt, retry schedule with jitter, single-serialisation webhook body, HTTP outcome mapping"
```

---

### Task 5: Config và luật config, lỗi, event, job, sweep, kill switch, partition, catalogue quyền; redact secret webhook

**Files:**
- Create: `src/modules/integrations/integrations.config.ts`, `src/modules/integrations/errors.ts`, `src/modules/integrations/events.ts`, `src/modules/integrations/jobs.ts`, `src/modules/integrations/kill-switches.ts`, `src/modules/integrations/partitions.ts`, `src/modules/integrations/permissions.ts`, `test/unit/modules/integrations/integrations-config.spec.ts`, `test/unit/modules/integrations/constants-vs-migration.spec.ts`, `test/unit/modules/integrations/definitions.spec.ts`
- Modify: `src/core/logging/redaction.ts`, `test/unit/core/logging/redaction.spec.ts`

**Interfaces:**
- Consumes: `defineConfig`, `defineConfigRule`, `numberAt`, `type ConfigOf` (`core/config`); `configRuleRegistry` (`core/config/config.registry.js`, chỉ test); `isValidCron`, `normalizeTimezone` (`core/scheduler`); `DEFINER_LIMIT_MAX` (`core/sweep`); `defineEvent`, `eventRegistry` (`core/events`); `defineQueue`, `defineJob`, `findJob` (`core/queue`); `defineOrgSweep`, `findOrgSweep` (`core/sweep`); `defineKillSwitch`, `findKillSwitch` (`core/flags`); `definePartitionedTable`, `partitionedTableRegistry` (`core/partitions`); `definePermissionCatalogue` (tenancy index); `defineErrorCodes` (`core/errors`), `defineConstraintErrors` (`core/database`); `BASE_REDACT_PATHS` (`core/logging/redaction.ts`); hằng Task 4.
- Produces:
  - `integrationsConfig` (namespace `integrations`, bảng env ở Step 2; thêm so với spec §11.4: `maxLocalFailures`, `maxInflightPerEndpoint` (R-X35), `sweepRequeueMaxPerOrg` (M5), `partitionPremakeMonths`), `type IntegrationsConfig`; luật `webhooks-bulkhead-covers-concurrency`.
  - `IntegrationsErrors`: `WEBHOOK_URL_NOT_ALLOWED` (422 `webhook_url_not_allowed`), `WEBHOOK_EVENT_TYPE_UNKNOWN` (422), `WEBHOOK_ENDPOINTS_LIMIT` (422), `WEBHOOK_ENDPOINT_DISABLED` (409), `WEBHOOK_DELIVERY_NOT_RETRYABLE` (409); đăng ký `webhook_endpoint_event_types_type_fk → WEBHOOK_EVENT_TYPE_UNKNOWN`.
  - Event (`audit: true, webhook: false`): `EndpointCreatedEvent { endpointId, urlHost, eventTypes }`, `EndpointUpdatedEvent { endpointId, changed, urlHost?, eventTypes? }`, `EndpointDeletedEvent { endpointId }`, `EndpointEnabledEvent { endpointId }`, `EndpointDisabledEvent { endpointId, reason }`, `EndpointSecretRotatedEvent { endpointId }`, `DeliveryExhaustedEvent { deliveryId, endpointId, eventType, eventId }`.
  - `WebhooksOutQueue` (`webhooks-out`, `io`), `DeliverWebhookJob` (`integrations.deliver-webhook`, `{ deliveryId }`, `onInactiveOrg: 'run'`), `IntegrationsSweepOrgJob` (`integrations.sweep-org`, `{}`, `'run'` — I4: lease hết hạn của org đã xoá mềm vẫn phải được hẹn lại, vì delivery của org đó vẫn gửi), `IntegrationsSweep` (`defineOrgSweep`, key `integrations.sweep-orgs`), `deliveryJobId(publicId, attempt)`, `killedJobId(publicId, attempt, atMs)`, `busyJobId(publicId, attempt, atMs)` (R-X35), `sweptJobId(publicId, attempt, slot)`.
  - `WebhookDeliveryKillSwitch` (`integrations.webhook_delivery`), `WebhookPartitions`, `WebhookPermissions` (catalogue `integrations`: `webhooks.read`, `webhooks.write`).
  - `BASE_REDACT_PATHS` có `webhookSecret`, `secretEnc` ở độ sâu 0–2.

- [ ] **Step 1: Unit test (fail)**

`test/unit/modules/integrations/integrations-config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { integrationsConfig } from '../../../../src/modules/integrations/integrations.config.js';

const parse = (raw: Record<string, string>) => integrationsConfig.schema.safeParse(raw);
const bulkheadRule = () => {
  const r = configRuleRegistry().find((x) => x.name === 'webhooks-bulkhead-covers-concurrency');
  if (!r) throw new Error('rule not registered');
  return r.rule;
};

describe('integrations config (spec SP6 §11.4)', () => {
  it('defaults match the spec table', () => {
    expect(integrationsConfig.schema.parse({})).toMatchObject({
      maxEndpointsPerOrg: 10,
      maxEventTypesPerEndpoint: 50,
      webhookTimeoutMs: 5000,
      deliveryLeaseMs: 60000,
      retryScheduleSec: [5, 300, 1800, 7200, 18000, 36000, 36000],
      endpointDisableAfterSec: 432000,
      secretRotationOverlapSec: 86400,
      deliveryRetentionMonths: 1,
      partitionPremakeMonths: 3,
      endpointPurgeDelaySec: 5356800,
      recoverBatchMax: 1000,
      killedRecheckSec: 60,
      localFaultRetrySec: 30,
      maxLocalFailures: 5,
      maxInflightPerEndpoint: 4,
      bulkheadLimit: 20,
      bulkheadQueue: 100,
      sweepCron: '*/5 * * * *',
      sweepTz: 'UTC',
      sweepBatchSize: 100,
      sweepMaxBatches: 20,
      sweepGraceSec: 120,
      sweepRequeueMaxPerOrg: 100,
    });
  });
  it.each([
    [{ retryScheduleSec: '' }, 'retryScheduleSec'],
    [{ retryScheduleSec: '5,abc' }, 'retryScheduleSec'],
    [{ retryScheduleSec: '0' }, 'retryScheduleSec'],
    [{ retryScheduleSec: Array.from({ length: 21 }, () => '1').join(',') }, 'retryScheduleSec'],
    [{ webhookTimeoutMs: '999' }, 'webhookTimeoutMs'],
    [{ webhookTimeoutMs: '30001' }, 'webhookTimeoutMs'],
    [{ maxEndpointsPerOrg: '101' }, 'maxEndpointsPerOrg'],
    [{ maxEventTypesPerEndpoint: '51' }, 'maxEventTypesPerEndpoint'],
    [{ maxLocalFailures: '0' }, 'maxLocalFailures'],
    [{ maxLocalFailures: '101' }, 'maxLocalFailures'],
    [{ maxInflightPerEndpoint: '0' }, 'maxInflightPerEndpoint'],
    [{ maxInflightPerEndpoint: '20' }, 'maxInflightPerEndpoint'],
    [{ sweepRequeueMaxPerOrg: '1001' }, 'sweepRequeueMaxPerOrg'],
    [{ deliveryRetentionMonths: '0' }, 'deliveryRetentionMonths'],
    [{ deliveryRetentionMonths: '25' }, 'deliveryRetentionMonths'],
    [{ secretRotationOverlapSec: '604801' }, 'secretRotationOverlapSec'],
    [{ localFaultRetrySec: '3601' }, 'localFaultRetrySec'],
    [{ sweepGraceSec: '86401' }, 'sweepGraceSec'],
    [{ sweepBatchSize: '1001' }, 'sweepBatchSize'],
    [{ sweepCron: 'nope' }, 'sweepCron'],
    [{ sweepTz: 'Mars/Olympus' }, 'sweepTz'],
  ])('refuses %j', (raw, path) => {
    const r = parse(raw);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(path);
  });
  it('refuses a timeout not below the lease, a disable window shorter than the schedule, and a purge delay shorter than (retention + 1) x 31 days', () => {
    expect(parse({ webhookTimeoutMs: '5000', deliveryLeaseMs: '5000' }).success).toBe(false);
    expect(parse({ retryScheduleSec: '100,100', endpointDisableAfterSec: '199' }).success).toBe(false);
    expect(parse({ deliveryRetentionMonths: '2', endpointPurgeDelaySec: String(3 * 31 * 86400 - 1) }).success).toBe(false);
    expect(parse({ deliveryRetentionMonths: '2', endpointPurgeDelaySec: String(3 * 31 * 86400) }).success).toBe(true);
  });
  it('bulkhead must cover the concurrency of webhooks-out, counting operator overrides (W-34)', () => {
    const rule = bulkheadRule();
    const base = { integrations: { bulkheadLimit: 20 }, queue: { ioConcurrency: 20, concurrencyOverrides: {} }, resilience: { overrides: {} } };
    expect(rule(base)).toBeUndefined();
    expect(rule({ ...base, queue: { ioConcurrency: 21, concurrencyOverrides: {} } })).toMatch(/INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT \(20\).*\(21\)/);
    expect(rule({ ...base, queue: { ioConcurrency: 20, concurrencyOverrides: { 'webhooks-out': 30 } } })).toMatch(/\(30\)/);
    expect(rule({ ...base, resilience: { overrides: { 'webhooks-out': { bulkheadLimit: 5 } } } })).toMatch(/\(5\)/);
    expect(rule({ queue: { ioConcurrency: 20 } })).toMatch(/needs the integrations and queue namespaces/);
  });
});
```
`test/unit/modules/integrations/constants-vs-migration.spec.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFINER_LIMIT_MAX } from '../../../../src/core/sweep/index.js';
import {
  WEBHOOK_DESCRIPTION_MAX_LENGTH, WEBHOOK_PARTITIONS_LOCK_KEY, WEBHOOK_RETENTION_MIN_MONTHS, WEBHOOK_URL_MAX_LENGTH, WEBHOOK_URL_MIN_LENGTH,
} from '../../../../src/modules/integrations/constants.js';
import { LAST_ERRORS } from '../../../../src/modules/integrations/domain/webhook-delivery.js';
import { WEBHOOK_BODY_MAX_BYTES } from '../../../../src/modules/integrations/domain/webhook-payload.js';

/** Migration viết cứng, test so với code (mẫu A-10 của spec SP6). */
const DIR = 'src/migrations/integrations';
const file = readdirSync(DIR).find((f) => f.endsWith('_webhooks.ts'));
const sql = file ? readFileSync(join(DIR, file), 'utf8') : '';

describe('constants hard-coded in the webhooks migration equal the code (spec SP6 §6.7)', () => {
  it('finds the migration', () => {
    expect(file).toBeDefined();
  });
  it('lock key, retention floor, body cap, url and description bounds, p_limit cap', () => {
    expect(sql).toContain(`pg_try_advisory_xact_lock(${WEBHOOK_PARTITIONS_LOCK_KEY})`);
    expect(sql).toContain(`p_retention_months < ${WEBHOOK_RETENTION_MIN_MONTHS} OR`);
    expect(sql).toContain(`octet_length(body) <= ${WEBHOOK_BODY_MAX_BYTES}`);
    expect(sql).toContain(`char_length(url) BETWEEN ${WEBHOOK_URL_MIN_LENGTH} AND ${WEBHOOK_URL_MAX_LENGTH}`);
    expect(sql).toContain(`char_length(description) BETWEEN 1 AND ${WEBHOOK_DESCRIPTION_MAX_LENGTH}`);
    expect(sql).toContain(`p_limit > ${DEFINER_LIMIT_MAX}`);
  });
  it('the last_error CHECK lists exactly LAST_ERRORS, in order', () => {
    const m = /webhook_deliveries_last_error_ck CHECK \(last_error IN \(([^)]*)\)\)/.exec(sql);
    expect(m?.[1]?.split(',').map((s) => s.trim().replaceAll("'", ''))).toEqual([...LAST_ERRORS]);
  });
});
```
`test/unit/modules/integrations/definitions.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defineConstraintErrors } from '../../../../src/core/database/index.js';
import { eventRegistry } from '../../../../src/core/events/index.js';
import { findKillSwitch } from '../../../../src/core/flags/index.js';
import { partitionedTableRegistry } from '../../../../src/core/partitions/index.js';
import { findJob } from '../../../../src/core/queue/index.js';
import { findOrgSweep } from '../../../../src/core/sweep/index.js';
import { WEBHOOK_PARTITIONS_LOCK_KEY } from '../../../../src/modules/integrations/constants.js';
import { IntegrationsErrors } from '../../../../src/modules/integrations/errors.js';
import '../../../../src/modules/integrations/events.js';
import {
  DeliverWebhookJob, IntegrationsSweep, IntegrationsSweepOrgJob, busyJobId, deliveryJobId, killedJobId, sweptJobId,
} from '../../../../src/modules/integrations/jobs.js';
import '../../../../src/modules/integrations/kill-switches.js';
import '../../../../src/modules/integrations/partitions.js';
import { WebhookPermissions } from '../../../../src/modules/integrations/permissions.js';

const ID = '0199a000-0000-7000-8000-000000000001';

describe('integrations definitions (spec SP6 §10, §9.1, §6.7)', () => {
  it('deliver and sweep-org both run for an inactive org (tenancy.org.deleted reaches the customer; its expired leases are rescheduled)', () => {
    expect(findJob('integrations.deliver-webhook')).toBe(DeliverWebhookJob);
    expect(DeliverWebhookJob).toMatchObject({ onInactiveOrg: 'run', queue: { name: 'webhooks-out', kind: 'io' } });
    expect(IntegrationsSweepOrgJob).toMatchObject({ onInactiveOrg: 'run', queue: { name: 'webhooks-out' } });
  });
  it('the sweep uses integrations_orgs_due with p_grace_sec by name (R-X14); its cron job runs on maintenance', () => {
    expect(findOrgSweep('integrations.sweep-orgs')).toBe(IntegrationsSweep);
    expect(IntegrationsSweep.definerFunction).toBe('integrations_orgs_due');
    expect(IntegrationsSweep.jobIdPrefix).toBe('integrations-sweep');
    expect(Object.keys(IntegrationsSweep.extraParams())).toEqual(['p_grace_sec']);
    expect(IntegrationsSweep.job.queue.name).toBe('maintenance');
  });
  it('job ids never contain ":" and never collide across the attempt, kill-switch, busy and sweep variants', () => {
    const ids = [deliveryJobId(ID, 3), killedJobId(ID, 3, 1_700_000_000_000), busyJobId(ID, 3, 1_700_000_000_000), sweptJobId(ID, 3, 42)];
    expect(ids).toEqual([`webhook-${ID}-a3`, `webhook-${ID}-a3-k1700000000000`, `webhook-${ID}-a3-b1700000000000`, `webhook-${ID}-a3-s42`]);
    for (const id of ids) expect(id).not.toContain(':');
  });
  it('kill switch, partition entry and permission catalogue are registered', () => {
    expect(findKillSwitch('integrations.webhook_delivery')).toBeDefined();
    expect(partitionedTableRegistry().find((d) => d.maintainFunction === 'webhook_partitions_maintain')).toMatchObject({
      tables: ['webhook_messages', 'webhook_deliveries'],
      lockKey: WEBHOOK_PARTITIONS_LOCK_KEY,
    });
    expect(WebhookPermissions.entries['webhooks.write']).toMatchObject({ apiKeyEligible: false, supportEligible: false, requires: ['webhooks.read'] });
    expect(WebhookPermissions.entries['webhooks.read']).toMatchObject({ apiKeyEligible: true, supportEligible: true, requires: [] });
  });
  it('every integrations event is audited and never a webhook itself (R-X3)', () => {
    const mine = eventRegistry().filter((d) => d.type.startsWith('integrations.'));
    expect(mine.map((d) => d.type).sort()).toEqual([
      'integrations.delivery.exhausted',
      'integrations.endpoint.created',
      'integrations.endpoint.deleted',
      'integrations.endpoint.disabled',
      'integrations.endpoint.enabled',
      'integrations.endpoint.secret_rotated',
      'integrations.endpoint.updated',
    ]);
    for (const d of mine) expect({ audit: d.audit, webhook: d.webhook }).toEqual({ audit: true, webhook: false });
  });
  it('the catalogue FK is registered as webhook_event_type_unknown (a second registration throws)', () => {
    expect(() => defineConstraintErrors({ webhook_endpoint_event_types_type_fk: IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN })).toThrow(
      'Constraint "webhook_endpoint_event_types_type_fk" already mapped',
    );
  });
});
```
`test/unit/core/logging/redaction.spec.ts`: thêm ca sau ca đầu (dùng `capture()` và `pino` có sẵn ở đầu file):
```ts
  it('censors webhook signing secrets and their ciphertext at any depth up to two (spec SP6 §5.3 core/logging)', () => {
    const { lines, stream } = capture();
    const log = pino({ redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } }, stream);
    log.info({ webhookSecret: 'ws-1', secretEnc: 'se-1', endpoint: { webhookSecret: 'ws-2', secretEnc: 'se-2', row: { secretEnc: 'se-3' } } });
    const out = lines.join('');
    for (const secret of ['ws-1', 'se-1', 'ws-2', 'se-2', 'se-3']) expect(out).not.toContain(secret);
  });
```
Run: `pnpm vitest run --project unit test/unit/modules/integrations test/unit/core/logging/redaction.spec.ts`
Expected: FAIL (file chưa có; `se-3` còn trong log).

- [ ] **Step 2: Config**

`src/modules/integrations/integrations.config.ts`:
```ts
import { z } from 'zod';
import { type ConfigOf, defineConfig, defineConfigRule, numberAt } from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from '../../core/sweep/index.js';
import { WEBHOOKS_OUT, WEBHOOK_EVENT_TYPES_MAX, WEBHOOK_RETENTION_MIN_MONTHS } from './constants.js';

const SECONDS_PER_DAY = 86_400;
/** Luật `PURGE_DELAY ≥ (RETENTION_MONTHS + 1) × 31 ngày` (spec §7.3, §11.4): 31 là số ngày tối đa của một tháng. */
const MAX_DAYS_PER_MONTH = 31;
const MAX_SCHEDULE_STEPS = 20;
const MAX_ENDPOINTS_PER_ORG = 100;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OVERLAP_SEC = 604_800;
const MAX_RETENTION_MONTHS = 24;
const MAX_PREMAKE_MONTHS = 12;
const MAX_LOCAL_FAULT_RETRY_SEC = 3600;
/** Trần vận hành của R-X35: quá trăm lần lỗi của ta liên tiếp là sự cố, không phải nhiễu. */
const MAX_LOCAL_FAILURES = 100;

const positiveInt = z.coerce.number().int().positive();
const cron = z.string().min(1).refine(isValidCron, 'must be a valid cron expression');
const timezone = z
  .string()
  .min(1)
  .refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name');
const csvSeconds = z
  .string()
  .default('5,300,1800,7200,18000,36000,36000')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number),
  )
  .pipe(z.array(z.number().int().min(1).max(SECONDS_PER_DAY)).min(1).max(MAX_SCHEDULE_STEPS));

export const integrationsConfig = defineConfig(
  'integrations',
  {
    maxEndpointsPerOrg: 'INTEGRATIONS_MAX_ENDPOINTS_PER_ORG',
    maxEventTypesPerEndpoint: 'INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT',
    webhookTimeoutMs: 'INTEGRATIONS_WEBHOOK_TIMEOUT_MS',
    deliveryLeaseMs: 'INTEGRATIONS_DELIVERY_LEASE_MS',
    retryScheduleSec: 'INTEGRATIONS_RETRY_SCHEDULE_SEC',
    endpointDisableAfterSec: 'INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC',
    secretRotationOverlapSec: 'INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC',
    deliveryRetentionMonths: 'INTEGRATIONS_DELIVERY_RETENTION_MONTHS',
    partitionPremakeMonths: 'INTEGRATIONS_PARTITION_PREMAKE_MONTHS',
    endpointPurgeDelaySec: 'INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC',
    recoverBatchMax: 'INTEGRATIONS_RECOVER_BATCH_MAX',
    killedRecheckSec: 'INTEGRATIONS_KILLED_RECHECK_SEC',
    localFaultRetrySec: 'INTEGRATIONS_LOCAL_FAULT_RETRY_SEC',
    maxLocalFailures: 'INTEGRATIONS_MAX_LOCAL_FAILURES',
    maxInflightPerEndpoint: 'INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT',
    bulkheadLimit: 'INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT',
    bulkheadQueue: 'INTEGRATIONS_WEBHOOK_BULKHEAD_QUEUE',
    sweepCron: 'INTEGRATIONS_SWEEP_CRON',
    sweepTz: 'INTEGRATIONS_SWEEP_TZ',
    sweepBatchSize: 'INTEGRATIONS_SWEEP_BATCH_SIZE',
    sweepMaxBatches: 'INTEGRATIONS_SWEEP_MAX_BATCHES',
    sweepGraceSec: 'INTEGRATIONS_SWEEP_GRACE_SEC',
    sweepRequeueMaxPerOrg: 'INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG',
  },
  z
    .object({
      maxEndpointsPerOrg: positiveInt.max(MAX_ENDPOINTS_PER_ORG).default(10).describe('Webhook endpoints per organization (deleted ones do not count)'),
      maxEventTypesPerEndpoint: positiveInt
        .max(WEBHOOK_EVENT_TYPES_MAX)
        .default(WEBHOOK_EVENT_TYPES_MAX)
        .describe(`Event types one endpoint may subscribe to (at most ${WEBHOOK_EVENT_TYPES_MAX}, the published API limit)`),
      webhookTimeoutMs: positiveInt
        .min(MIN_TIMEOUT_MS)
        .max(MAX_TIMEOUT_MS)
        .default(5000)
        .describe('Timeout of one webhook request (must be below INTEGRATIONS_DELIVERY_LEASE_MS)'),
      deliveryLeaseMs: positiveInt.default(60_000).describe('Lease of a delivery being sent; an expired lease is retried as our fault'),
      retryScheduleSec: csvSeconds.describe('Comma-separated retry delays in seconds after each failed attempt (1-20 steps of 1-86400)'),
      endpointDisableAfterSec: positiveInt
        .default(432_000)
        .describe('An endpoint failing this long without a success is disabled (must cover the retry schedule)'),
      secretRotationOverlapSec: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_OVERLAP_SEC)
        .default(86_400)
        .describe('Seconds the previous signing secret keeps signing after a rotation'),
      deliveryRetentionMonths: positiveInt
        .min(WEBHOOK_RETENTION_MIN_MONTHS)
        .max(MAX_RETENTION_MONTHS)
        .default(1)
        .describe('Months of webhook messages and deliveries kept (whole months, partition drop)'),
      partitionPremakeMonths: positiveInt.max(MAX_PREMAKE_MONTHS).default(3).describe('Future monthly partitions kept ready for the webhook tables'),
      endpointPurgeDelaySec: positiveInt.default(5_356_800).describe('Seconds after a soft delete before an endpoint row is removed'),
      recoverBatchMax: positiveInt.default(1000).describe('Deliveries re-queued by one recover call'),
      killedRecheckSec: positiveInt.default(60).describe('Recheck delay of a delivery while the integrations.webhook_delivery kill switch is on'),
      localFaultRetrySec: positiveInt
        .max(MAX_LOCAL_FAULT_RETRY_SEC)
        .default(30)
        .describe('Retry delay after a fault on our side (bulkhead, breaker, lost lease, unreadable secret, endpoint busy)'),
      maxLocalFailures: positiveInt
        .max(MAX_LOCAL_FAILURES)
        .default(5)
        .describe('Faults on our side one delivery may hit before it is exhausted (recoverable with retry/recover)'),
      maxInflightPerEndpoint: positiveInt
        .default(4)
        .describe('Deliveries one endpoint may have in flight at once (must be below INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT)'),
      bulkheadLimit: positiveInt.default(20).describe('Concurrent webhook requests per process (at least the webhooks-out queue concurrency)'),
      bulkheadQueue: z.coerce.number().int().min(0).default(100).describe('Queued webhook requests per process'),
      sweepCron: cron.default('*/5 * * * *').describe('Cron of integrations.sweep-orgs'),
      sweepTz: timezone.default('UTC').describe('Timezone of the integrations sweep cron'),
      sweepBatchSize: positiveInt.max(DEFINER_LIMIT_MAX).default(100).describe('Organizations per sweep batch'),
      sweepMaxBatches: positiveInt.default(20).describe('Max sweep batches per cron run'),
      sweepGraceSec: positiveInt
        .max(SECONDS_PER_DAY)
        .default(120)
        .describe('A delivery overdue or a lease expired by more than this is taken over by the sweep'),
      sweepRequeueMaxPerOrg: positiveInt
        .max(DEFINER_LIMIT_MAX)
        .default(100)
        .describe('Overdue deliveries, expired leases and due endpoint deletes handled per organization per sweep pass'),
    })
    .superRefine((c, ctx) => {
      if (c.webhookTimeoutMs >= c.deliveryLeaseMs)
        ctx.addIssue({ code: 'custom', path: ['webhookTimeoutMs'], message: 'must be below INTEGRATIONS_DELIVERY_LEASE_MS' });
      // R-X35: bằng hoặc hơn bulkhead của process thì một endpoint chết vẫn chiếm hết slot — trần in-flight mất nghĩa.
      if (c.maxInflightPerEndpoint >= c.bulkheadLimit)
        ctx.addIssue({ code: 'custom', path: ['maxInflightPerEndpoint'], message: 'must be below INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT' });
      const total = c.retryScheduleSec.reduce((a, b) => a + b, 0);
      if (c.endpointDisableAfterSec < total)
        ctx.addIssue({ code: 'custom', path: ['endpointDisableAfterSec'], message: `must be at least the sum of the retry schedule (${total})` });
      const minPurge = (c.deliveryRetentionMonths + 1) * MAX_DAYS_PER_MONTH * SECONDS_PER_DAY;
      if (c.endpointPurgeDelaySec < minPurge)
        ctx.addIssue({ code: 'custom', path: ['endpointPurgeDelaySec'], message: `must be at least ${minPurge} ((retention months + 1) x 31 days)` });
    }),
);
export type IntegrationsConfig = ConfigOf<typeof integrationsConfig>;

/**
 * Spec §11.4 `webhooks-bulkhead-covers-concurrency`: mỗi job gửi đúng một request, nên với bulkhead ≥ concurrency của queue
 * `webhooks-out` một process không bao giờ nhận `bulkhead_full`. Tính cả override của người vận hành
 * (`RESILIENCE_OVERRIDES.webhooks-out.bulkheadLimit` thắng default của provider; `QUEUE_CONCURRENCY_OVERRIDES` webhooks-out=n).
 * `queue` và `resilience` là namespace core (luôn có); luật đăng ký lúc import file này, tức chỉ khi module integrations bật.
 */
defineConfigRule('webhooks-bulkhead-covers-concurrency', (c) => {
  const own = numberAt(c, 'integrations', 'bulkheadLimit');
  const io = numberAt(c, 'queue', 'ioConcurrency');
  if (own === undefined || io === undefined) return 'webhooks bulkhead rule needs the integrations and queue namespaces';
  const limit = numberAt(c, 'resilience', 'overrides', WEBHOOKS_OUT, 'bulkheadLimit') ?? own;
  const concurrency = numberAt(c, 'queue', 'concurrencyOverrides', WEBHOOKS_OUT) ?? io;
  return limit >= concurrency
    ? undefined
    : `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT (${limit}) must be at least the concurrency of queue ${WEBHOOKS_OUT} (${concurrency}); set RESILIENCE_OVERRIDES/QUEUE_CONCURRENCY_OVERRIDES consistently`;
});
```

- [ ] **Step 3: Lỗi, event, job, sweep, kill switch, partition, catalogue, redact**

`src/modules/integrations/errors.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { defineErrorCodes } from '../../core/errors/index.js';

/** Mã do integrations sở hữu (spec SP6 §9.4, cột "Chủ" = integrations). */
export const IntegrationsErrors = defineErrorCodes({
  WEBHOOK_URL_NOT_ALLOWED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'This webhook URL is not allowed' },
  WEBHOOK_EVENT_TYPE_UNKNOWN: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Unknown webhook event type' },
  WEBHOOK_ENDPOINTS_LIMIT: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Webhook endpoint limit reached' },
  WEBHOOK_ENDPOINT_DISABLED: { status: HttpStatus.CONFLICT, title: 'The webhook endpoint is not active' },
  WEBHOOK_DELIVERY_NOT_RETRYABLE: { status: HttpStatus.CONFLICT, title: 'The delivery is still pending or being sent' },
});

/** Catalog event type bị gỡ giữa lúc kiểm và lúc ghi đăng ký (race hẹp): cùng mã với kiểm ở service. */
defineConstraintErrors({
  webhook_endpoint_event_types_type_fk: IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
});
```
`src/modules/integrations/events.ts`:
```ts
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { WEBHOOK_EVENT_TYPE_PATTERN } from './constants.js';
import { DISABLED_REASONS } from './domain/webhook-endpoint.js';

/**
 * Event của 6C (spec SP6 §10): `audit: true` (thao tác trên kênh xuất dữ liệu của org), `webhook: false` (không tự phát
 * webhook về chính webhook). Payload chỉ id công khai và host, không URL, không secret.
 */
const id = z.uuid();
const eventTypes = z.array(z.string().regex(WEBHOOK_EVENT_TYPE_PATTERN)).min(1);
export const EndpointCreatedEvent = defineEvent({
  type: 'integrations.endpoint.created',
  version: 1,
  schema: z.object({ endpointId: id, urlHost: z.string().min(1), eventTypes }),
  audit: true,
  webhook: false,
});
export const EndpointUpdatedEvent = defineEvent({
  type: 'integrations.endpoint.updated',
  version: 1,
  schema: z.object({
    endpointId: id,
    changed: z.array(z.enum(['url', 'description', 'eventTypes'])).min(1),
    urlHost: z.string().min(1).optional(),
    eventTypes: eventTypes.optional(),
  }),
  audit: true,
  webhook: false,
});
export const EndpointDeletedEvent = defineEvent({
  type: 'integrations.endpoint.deleted',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const EndpointEnabledEvent = defineEvent({
  type: 'integrations.endpoint.enabled',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const EndpointDisabledEvent = defineEvent({
  type: 'integrations.endpoint.disabled',
  version: 1,
  schema: z.object({ endpointId: id, reason: z.enum(DISABLED_REASONS) }),
  audit: true,
  webhook: false,
});
export const EndpointSecretRotatedEvent = defineEvent({
  type: 'integrations.endpoint.secret_rotated',
  version: 1,
  schema: z.object({ endpointId: id }),
  audit: true,
  webhook: false,
});
export const DeliveryExhaustedEvent = defineEvent({
  type: 'integrations.delivery.exhausted',
  version: 1,
  schema: z.object({ deliveryId: id, endpointId: id, eventType: z.string().min(1), eventId: id }),
  audit: true,
  webhook: false,
});
```
`src/modules/integrations/jobs.ts`:
```ts
import { z } from 'zod';
import { defineJob, defineQueue } from '../../core/queue/index.js';
import { defineOrgSweep } from '../../core/sweep/index.js';
import { WEBHOOKS_OUT } from './constants.js';
import { integrationsConfig } from './integrations.config.js';

/** Queue riêng cho lời gọi ra ngoài (spec cha §6): một endpoint chậm chỉ chiếm slot của queue này. */
export const WebhooksOutQueue = defineQueue(WEBHOOKS_OUT, { kind: 'io' });
/** Payload chỉ có id (không URL, không body). `run`: delivery sinh trước khi org bị xoá mềm vẫn được gửi (spec §8.3). */
export const DeliverWebhookJob = defineJob({
  name: 'integrations.deliver-webhook',
  queue: WebhooksOutQueue,
  version: 1,
  schema: z.object({ deliveryId: z.uuid() }).strict(),
  onInactiveOrg: 'run',
});
/**
 * Việc theo org của sweep (org trong `meta.orgId`). `run` cả khi org đã xoá mềm (review 6C I4, spec §10 sửa theo): delivery
 * của org đó vẫn được gửi (`DeliverWebhookJob` là `run`), nên lease hết hạn hay job bị mất của nó cũng phải được sweep lấy
 * lại; `skip` sẽ để delivery `SENDING` kẹt tới khi purge. Org đã purge thì không còn dòng nào để quét.
 */
export const IntegrationsSweepOrgJob = defineJob({
  name: 'integrations.sweep-org',
  queue: WebhooksOutQueue,
  version: 1,
  schema: z.object({}),
  onInactiveOrg: 'run',
});
/** Spec §8.3 "Sweep", R-X14: tham số thêm theo tên; cron ở `maintenance`, việc theo org ở `webhooks-out`. */
export const IntegrationsSweep = defineOrgSweep({
  key: 'integrations.sweep-orgs',
  definerFunction: 'integrations_orgs_due',
  extraParams: () => ({ p_grace_sec: integrationsConfig().sweepGraceSec }),
  orgJob: IntegrationsSweepOrgJob,
  jobIdPrefix: 'integrations-sweep',
  schedule: () => {
    const c = integrationsConfig();
    return { cron: c.sweepCron, tz: c.sweepTz };
  },
  batch: () => {
    const c = integrationsConfig();
    return { size: c.sweepBatchSize, maxBatches: c.sweepMaxBatches };
  },
});

/** jobId của lần thử thứ `attempt` (spec §10). Chỉ dùng cho attempt chưa từng được claim (xem `DeliveryEffect`). */
export const deliveryJobId = (publicId: string, attempt: number): string => `webhook-${publicId}-a${attempt}`;
/**
 * Hẹn kiểm lại khi kill switch bật: job `a<attempt>` đang chạy còn trong Redis (active rồi completed), dùng lại id đó sẽ bị
 * BullMQ bỏ qua. Hậu tố mốc thời gian làm mỗi lần hẹn là một job mới.
 */
export const killedJobId = (publicId: string, attempt: number, atMs: number): string => `webhook-${publicId}-a${attempt}-k${atMs}`;
/** Claim bị từ chối vì endpoint đã đủ in-flight (R-X35): cùng lý do với `killedJobId` (job `a<attempt>` đang chạy còn trong Redis). */
export const busyJobId = (publicId: string, attempt: number, atMs: number): string => `webhook-${publicId}-a${attempt}-b${atMs}`;
/** Sweep enqueue lại delivery quá hạn: tối đa một job mỗi slot của sweep, không bị job đã hoàn tất cùng id nuốt mất. */
export const sweptJobId = (publicId: string, attempt: number, slot: number): string => `webhook-${publicId}-a${attempt}-s${slot}`;
```
`src/modules/integrations/kill-switches.ts`:
```ts
import { defineKillSwitch } from '../../core/flags/index.js';

/** Spec SP6 §1 (11): bật → không request ra ngoài; delivery giữ nguyên và chạy lại khi tắt. */
export const WebhookDeliveryKillSwitch = defineKillSwitch({
  key: 'integrations.webhook_delivery',
  description: 'Stops outbound webhook requests; deliveries wait and resume when the switch is turned off',
});
```
`src/modules/integrations/partitions.ts`:
```ts
import { definePartitionedTable } from '../../core/partitions/index.js';
import { WEBHOOK_PARTITIONS_LOCK_KEY } from './constants.js';
import { integrationsConfig } from './integrations.config.js';

/** Spec §6.7: một hàm bảo trì lo cả hai bảng (drop deliveries trước messages, spike P2); cron `core.partitions.maintain` gọi. */
export const WebhookPartitions = definePartitionedTable({
  tables: ['webhook_messages', 'webhook_deliveries'],
  maintainFunction: 'webhook_partitions_maintain',
  lockKey: WEBHOOK_PARTITIONS_LOCK_KEY,
  retentionMonths: () => integrationsConfig().deliveryRetentionMonths,
  premakeMonths: () => integrationsConfig().partitionPremakeMonths,
});
```
`src/modules/integrations/permissions.ts`:
```ts
import { definePermissionCatalogue } from '../tenancy/index.js';

/**
 * Spec SP6 §9.1. `webhooks.write` không `apiKeyEligible`: một key bị lộ không mở được kênh xuất dữ liệu (S6-A35); không
 * `supportEligible`. Thêm quyền có `grantTo.admin` làm `perms(ADMIN)` lớn lên (spec SP3 §8.2; README ghi hệ quả).
 */
export const WebhookPermissions = definePermissionCatalogue('integrations', {
  'webhooks.read': {
    resource: 'webhooks',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: true,
    grantTo: { admin: true, member: false },
  },
  'webhooks.write': {
    resource: 'webhooks',
    action: 'write',
    requires: ['webhooks.read'],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: true, member: false },
  },
});
```
`src/core/logging/redaction.ts`: thêm vào `BASE_REDACT_PATHS` ngay sau cụm `'security.keys', '*.security.keys',` (đọc file để đặt đúng chỗ):
```ts
  // Secret ký webhook (SP6 6C): bản rõ chỉ trả một lần qua API; bản mã hoá ở `webhook_endpoint_secrets.secret_enc`.
  'webhookSecret',
  '*.webhookSecret',
  '*.*.webhookSecret',
  'secretEnc',
  '*.secretEnc',
  '*.*.secretEnc',
```

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations test/unit/core/logging/redaction.spec.ts test/unit/core/events
pnpm typecheck
```
Expected: PASS (`event-flags.spec.ts` của 6.0: event `integrations.*` khai đủ hai cờ). `definitions.spec.ts` ca cuối chứng minh đăng ký constraint tồn tại (gọi lại ném "already mapped").

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/integrations src/core/logging/redaction.ts test/unit/modules/integrations test/unit/core/logging/redaction.spec.ts
git add src/modules/integrations src/core/logging/redaction.ts test/unit/modules/integrations test/unit/core/logging/redaction.spec.ts
git commit -m "feat(integrations): config with the bulkhead rule, error codes, audited events, deliver and sweep jobs, kill switch, partition entry, webhooks catalogue; redact webhook secrets"
```

---

### Task 6: Khung module — `WebhookEventCatalogueCheck` (R-X30), metric, telemetry, `IntegrationsModule`, `index.ts`

**Files:**
- Create: `src/modules/integrations/integrations-telemetry.ts`, `src/modules/integrations/application/integrations-metrics.ts`, `src/modules/integrations/application/event-catalogue-check.ts`, `src/modules/integrations/integrations.module.ts`, `src/modules/integrations/index.ts`, `test/unit/modules/integrations/event-catalogue-check.spec.ts`, `test/integration/integrations/event-catalogue-check.spec.ts`
- Modify: `.dependency-cruiser.cjs` (bỏ ngoại lệ `no-orphans` của `admin-readers.ts`)

**Interfaces:**
- Consumes: `Db` (`core/database`); `eventRegistry`, `type EventDef` (`core/events`); `metrics` (`@opentelemetry/api`); `PermissionCatalogueContributor` (tenancy index); `SecurityModule` (`core/security`), `ResilienceModule` (`core/resilience`); `markModuleLoaded`, `loadedModules`, `configRegistry`, `validateAllConfigs` (`core/config`); `composeAppModules`, `BOILERPLATE_MODULES` (`src/boilerplate.modules.ts`); `queueRegistry`, `jobRegistry` (`core/queue`); `cronRegistry` (`core/scheduler/cron-definition.js`); `buildTestApp`, `createTestApp` (`test/support/app-factory.ts`), `tenancyCoreImports`; `baseTestEnv`; mọi định nghĩa Task 5.
- Produces:
  - `WebhookEventCatalogueCheck` (`onModuleInit`, api + worker): `known(): ReadonlySet<string>` (type `webhook: true` trong code, đều có ở DB sau kiểm), `definitions(): readonly EventDef[]` (def `webhook: true`, sắp theo `type@version`); thiếu ở DB → ERROR `webhook_event_catalogue_mismatch` + ném; chỉ có ở DB → WARN một lần `webhook_event_types_unknown_to_code` + `webhook_event_types_unknown_to_code_total`.
  - `IntegrationsMetrics` (counter/histogram spec §15: `deliveries`, `attemptDuration`, `exhausted`, `autoDisabled`, `lag`, `localFaults`, `catalogueUnknownTypes`); `integrationsSpan(name, fn, attrsOf?)`; `INTEGRATIONS_METER`.
  - `IntegrationsCoreModule` (`@Global`), `IntegrationsHttpModule`, `IntegrationsReadersModule` (`@Global`), `IntegrationsWorkerModule`, `IntegrationsModule.forApi()` / `.forWorker()` (Task 7–15 thêm provider/controller).
  - `src/modules/integrations/index.ts` (dòng đầu `markModuleLoaded('integrations')`). Mục composition (R-X16) và X-9: Task 13 Step 4.

- [ ] **Step 1: Test kiểm catalog (fail)**

`test/unit/modules/integrations/event-catalogue-check.spec.ts` (unit với `Db` giả: ca thiếu dòng không được sửa bảng dùng chung, vì xoá một dòng `webhook_event_types` làm mọi file khác đang boot song song đỏ theo):
```ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../../src/core/database/index.js';
import '../../../../src/modules/tenancy/events.js';
import { WebhookEventCatalogueCheck } from '../../../../src/modules/integrations/application/event-catalogue-check.js';
import { IntegrationsMetrics } from '../../../../src/modules/integrations/application/integrations-metrics.js';

/** Sáu event `webhook: true` của tenancy (6.0 đặt cờ): nạp `tenancy/events.ts` ở trên. */
const SIX = [
  'tenancy.member.added', 'tenancy.member.removed', 'tenancy.member.role_changed',
  'tenancy.org.deleted', 'tenancy.org.restored', 'tenancy.org.updated',
];
const dbWith = (types: string[]): Db => {
  const execute = vi.fn(async () => types.map((type) => ({ type })));
  // Db chỉ cần `execute` ở đây; ép qua Pick để không giả toàn bộ lớp (không có `any`).
  return { execute } as Pick<Db, 'execute'> as Db;
};
const eventOf = (call: unknown[]): unknown => (typeof call[0] === 'object' && call[0] !== null && 'event' in call[0] ? call[0].event : undefined);
const check = (types: string[]) => new WebhookEventCatalogueCheck(dbWith(types), new IntegrationsMetrics());

describe('WebhookEventCatalogueCheck (spec SP6 §6.5, R-X30, W-43 boot part)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes when every webhook:true type has a row; known() and definitions() list the code types', async () => {
    const c = check(SIX);
    await expect(c.onModuleInit()).resolves.toBeUndefined();
    expect([...c.known()].sort()).toEqual(SIX);
    expect(c.definitions().map((d) => d.type)).toEqual([...SIX].sort());
  });
  it('refuses to boot when a webhook:true type is missing, naming it and logging webhook_event_catalogue_mismatch', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(check(SIX.filter((t) => t !== 'tenancy.org.restored')).onModuleInit()).rejects.toThrow(
      'missing in webhook_event_types: tenancy.org.restored',
    );
    expect(error.mock.calls.map(eventOf)).toContain('webhook_event_catalogue_mismatch');
  });
  it('a row unknown to this code only warns, once (R-X30: newer DB, rolling deploy, or its module is disabled)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = check([...SIX, 'files.file.ready']);
    await expect(c.onModuleInit()).resolves.toBeUndefined();
    expect(warn.mock.calls.map(eventOf)).toEqual(['webhook_event_types_unknown_to_code']);
    expect(c.known().has('files.file.ready')).toBe(false);
  });
  it('known() before the check ran is a wiring bug and throws', () => {
    expect(() => check(SIX).known()).toThrow(/before onModuleInit/);
  });
});
```
`test/integration/integrations/event-catalogue-check.spec.ts` (boot thật trên DB dùng chung, không sửa dữ liệu):
```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FlagsModule } from '../../../src/core/flags/index.js';
import { SweepModule } from '../../../src/core/sweep/index.js';
import { WebhookEventCatalogueCheck } from '../../../src/modules/integrations/application/event-catalogue-check.js';
import { IntegrationsModule } from '../../../src/modules/integrations/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

describe('WebhookEventCatalogueCheck on the migrated database (spec SP6 §6.5)', () => {
  afterAll(() => vi.unstubAllEnvs());
  it('a worker composition of integrations boots against the rows of the webhooks migration', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    const app = await createTestApp([...tenancyCoreImports(), FlagsModule, SweepModule, IntegrationsModule.forWorker()]);
    try {
      expect([...app.get(WebhookEventCatalogueCheck).known()]).toContain('tenancy.org.updated');
    } finally {
      await app.close();
    }
  });
});
```
Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations/event-catalogue-check.spec.ts
pnpm vitest run --project integration test/integration/integrations/event-catalogue-check.spec.ts
```
Expected: FAIL (file chưa có).

- [ ] **Step 2: Telemetry, metric, kiểm catalog**

`src/modules/integrations/integrations-telemetry.ts`:
```ts
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const INTEGRATIONS_METER = 'integrations';
const INTEGRATIONS_TRACER = 'integrations';

/** Span con (spec SP6 §15): attribute chỉ là enum hữu hạn; không org, URL, body; lỗi chỉ ghi tên class và mã `AppError`. */
export async function integrationsSpan<T>(name: string, fn: () => Promise<T>, attrsOf?: (result: T) => Attributes): Promise<T> {
  return trace.getTracer(INTEGRATIONS_TRACER).startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      if (attrsOf) span.setAttributes(attrsOf(result));
      return result;
    } catch (err) {
      const type = err instanceof Error ? err.constructor.name : typeof err;
      const code = err instanceof AppError ? err.error.code : undefined;
      span.recordException(code ? { name: type, code } : { name: type });
      span.setAttributes(code ? { 'error.type': type, 'integrations.error_code': code } : { 'error.type': type });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
(`AppError.error` là `ErrorCode` có `code`, đã đối chiếu `src/core/errors/app-error.ts`.)

`src/modules/integrations/application/integrations-metrics.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { INTEGRATIONS_METER } from '../integrations-telemetry.js';

/** Spec SP6 §15: label là enum hữu hạn; không `orgId`, endpoint, URL. */
@Injectable()
export class IntegrationsMetrics {
  private readonly meter = metrics.getMeter(INTEGRATIONS_METER);
  readonly deliveries = this.meter.createCounter('webhook_deliveries_total', { description: 'Webhook attempts and claims by result' });
  readonly attemptDuration = this.meter.createHistogram('webhook_delivery_attempt_duration_seconds', {
    description: 'Duration of one webhook request',
    unit: 's',
  });
  readonly exhausted = this.meter.createCounter('webhook_deliveries_exhausted_total', { description: 'Deliveries that used up their retry schedule' });
  readonly autoDisabled = this.meter.createCounter('webhook_endpoints_auto_disabled_total', { description: 'Endpoints disabled after failing too long' });
  readonly lag = this.meter.createHistogram('webhook_delivery_lag_seconds', { description: 'From delivery creation to its success', unit: 's' });
  readonly localFaults = this.meter.createCounter('webhook_local_faults_total', { description: 'Attempts that failed on our side, by reason' });
  readonly catalogueUnknownTypes = this.meter.createCounter('webhook_event_types_unknown_to_code_total', {
    description: 'Rows of webhook_event_types that this code does not define (R-X30), counted at boot',
  });
}
```
`src/modules/integrations/application/event-catalogue-check.ts`:
```ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import { eventRegistry, type EventDef } from '../../../core/events/index.js';
import { IntegrationsMetrics } from './integrations-metrics.js';

const Rows = z.array(z.object({ type: z.string() }));

/**
 * Spec SP6 §6.5 + R-X30: type có `webhook: true` trong code phải có dòng ở `webhook_event_types` (đăng ký cần FK), thiếu →
 * không khởi động (một migration chưa chạy). Dòng chỉ có ở DB (DB mới hơn code lúc rolling deploy, hoặc module phát event bị
 * tắt) là trơ: WARN một lần + metric, vẫn khởi động; API không nhận type đó (`known()` chỉ có type code biết).
 * `onModuleInit` (không phải `onApplicationBootstrap`): worker chưa nhận job nào khi kiểm (bài học `CatalogueCheck` của 3A).
 */
@Injectable()
export class WebhookEventCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventCatalogueCheck.name);
  private codeTypes: ReadonlySet<string> | undefined;
  constructor(
    private readonly db: Db,
    private readonly metrics: IntegrationsMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const code = new Set(this.webhookDefs().map((d) => d.type));
    const db = new Set(Rows.parse(await this.db.execute('SELECT type FROM webhook_event_types')).map((r) => r.type));
    const missing = [...code].filter((t) => !db.has(t)).sort();
    const unknown = [...db].filter((t) => !code.has(t)).sort();
    if (unknown.length > 0) {
      this.metrics.catalogueUnknownTypes.add(unknown.length);
      this.logger.warn({ event: 'webhook_event_types_unknown_to_code', types: unknown }, 'webhook event types this code does not define are inert');
    }
    if (missing.length > 0) {
      this.logger.error({ event: 'webhook_event_catalogue_mismatch', missing }, 'webhook events are missing from webhook_event_types');
      throw new Error(`Webhook event catalogue mismatch: missing in webhook_event_types: ${missing.join(', ')}`);
    }
    this.codeTypes = code;
  }

  /** Type đăng ký được (code biết, DB có). Gọi trước khi kiểm xong là lỗi lắp ráp. */
  known(): ReadonlySet<string> {
    if (!this.codeTypes) throw new Error('WebhookEventCatalogueCheck.known() called before onModuleInit');
    return this.codeTypes;
  }

  /** Def `webhook: true` (mọi version), sắp theo `type@version`: nguồn của `GET /v1/webhook-event-types`. */
  definitions(): readonly EventDef[] {
    return this.webhookDefs();
  }

  private webhookDefs(): EventDef[] {
    return eventRegistry()
      .filter((d) => d.webhook)
      .sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version);
  }
}
```

- [ ] **Step 3: Module, index, composition**

`src/modules/integrations/integrations.module.ts`:
```ts
import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { ResilienceModule } from '../../core/resilience/index.js';
import { SecurityModule } from '../../core/security/index.js';
import { PermissionCatalogueContributor } from '../tenancy/index.js';
import { WebhookEventCatalogueCheck } from './application/event-catalogue-check.js';
import { IntegrationsMetrics } from './application/integrations-metrics.js';
import { WebhookPermissions } from './permissions.js';
import './errors.js';
import './events.js';
import './integrations.config.js';
import './jobs.js';
import './kill-switches.js';
import './partitions.js';

@Injectable()
@PermissionCatalogueContributor(WebhookPermissions)
class IntegrationsCatalogueContributor {}

/**
 * Phần dùng chung api + worker (mẫu `TenancyCoreModule`): `forApi()` và `forWorker()` cùng import module tĩnh này, nên một
 * process dựng cả hai (test e2e) vẫn chỉ có một instance. Catalogue quyền ở cả hai process (SP3 INT3-5).
 * `SecurityModule`/`ResilienceModule` phải được module dùng đăng ký (ADR 0016 "Hệ quả").
 */
@Global()
@Module({
  imports: [SecurityModule, ResilienceModule],
  providers: [IntegrationsMetrics, IntegrationsCatalogueContributor, WebhookEventCatalogueCheck],
  exports: [IntegrationsMetrics, WebhookEventCatalogueCheck],
})
export class IntegrationsCoreModule {}

/** Chỉ api: controller (Task 8, 9, 14). */
@Module({ controllers: [], providers: [] })
export class IntegrationsHttpModule {}

/** Chỉ api: bản cài token `WebhookStatsReader` của `core/contracts` cho admin (Task 10, R-X16). */
@Global()
@Module({ providers: [], exports: [] })
export class IntegrationsReadersModule {}

/** Chỉ worker: fan-out, gửi, sweep, participant, policy của `webhooks-out` (Task 10–15). */
@Module({ providers: [] })
export class IntegrationsWorkerModule {}

@Module({})
export class IntegrationsModule {
  static forApi(): DynamicModule {
    return { module: IntegrationsModule, imports: [IntegrationsCoreModule, IntegrationsHttpModule, IntegrationsReadersModule] };
  }
  static forWorker(): DynamicModule {
    return { module: IntegrationsModule, imports: [IntegrationsCoreModule, IntegrationsWorkerModule] };
  }
}
```
`src/modules/integrations/index.ts`:
```ts
import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4, R-X16): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('integrations');

export { IntegrationsModule } from './integrations.module.js';
export { integrationsConfig, type IntegrationsConfig } from './integrations.config.js';
export { IntegrationsErrors } from './errors.js';
export {
  DeliveryExhaustedEvent,
  EndpointCreatedEvent,
  EndpointDeletedEvent,
  EndpointDisabledEvent,
  EndpointEnabledEvent,
  EndpointSecretRotatedEvent,
  EndpointUpdatedEvent,
} from './events.js';
export { WebhookPermissions } from './permissions.js';
export { WebhookDeliveryKillSwitch } from './kill-switches.js';
```
Composition (R-X16: khoá `BoilerplateModuleKey`, mục `BOILERPLATE_MODULES`, dòng `MODULE_REQUIRES`, X-9) nối ở **Task 13 Step 2**, sau khi mọi `@JobHandler` của module đã có (Task 11: gửi và hai handler sweep): `WorkerHost` từ chối khởi động khi một job trên queue được consume không có handler (`worker-host.ts:107-116`), nên nối sớm hơn sẽ làm đỏ mọi test dựng worker đầy đủ (`startWorker`, app process, smoke) từ Task 6 tới Task 11. Tới lúc đó test của 6C dựng module trực tiếp (`IntegrationsModule.forApi()`/`.forWorker()`).

`.dependency-cruiser.cjs`: xoá hai dòng chú thích và dòng `'(^|/)src/core/contracts/admin-readers[.]ts$',` trong `pathNot` của `no-orphans` (6.0 ghi "plan đầu tiên import nó xoá ngoại lệ này"; Task 10 import nó). Nếu 6A đã xoá thì bỏ qua.

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations test/unit/core/events
pnpm vitest run --project integration test/integration/integrations/event-catalogue-check.spec.ts test/integration/tenancy/catalogue-check.spec.ts
pnpm typecheck
pnpm arch
```
Expected: unit PASS (kiểm catalog 4 ca, `event-flags.spec.ts`); integration PASS (worker của integrations boot trên dòng của Task 2; `catalogue-check.spec.ts` của 3A xanh với catalogue `integrations`); `pnpm arch` có thể cảnh báo `no-orphans` cho file chưa được import tới Task 10 (mức `warn`, exit 0).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/integrations .dependency-cruiser.cjs test/unit/modules/integrations test/integration/integrations
git add src/modules/integrations .dependency-cruiser.cjs test/unit/modules/integrations test/integration/integrations/event-catalogue-check.spec.ts
git commit -m "feat(integrations): module frame with the tolerant webhook event catalogue check, metrics and telemetry"
```

---

## Phần D — API endpoint (spec §8.3 "Đăng ký", "Các thao tác khác", §9.2, §9.3, §7.3, §7.4)

### Task 7: Port `UrlGuard` + `DnsUrlGuard` (SSRF lúc đăng ký), port `WebhookSigner` + `StandardWebhooksSigner`, `WebhookSecrets` — W-20, W-21, W-1…W-3 mức unit, Review Focus 1–2

**Files:**
- Create: `src/modules/integrations/ports/url-guard.ts`, `src/modules/integrations/ports/webhook-signer.ts`, `src/modules/integrations/infra/dns-url-guard.ts`, `src/modules/integrations/infra/standard-webhooks.signer.ts`, `src/modules/integrations/application/webhook-secrets.ts`, `test/unit/modules/integrations/dns-url-guard.spec.ts`, `test/unit/modules/integrations/standard-webhooks.signer.spec.ts`, `test/unit/modules/integrations/webhook-secrets.spec.ts`
- Modify: `src/modules/integrations/integrations.module.ts`

**Interfaces:**
- Consumes: `assertUrlAllowed`, `isPublicAddress`, `parseCidrs`, `SsrfBlockedError`, `resilienceConfig` (`core/resilience`); `type ConfigOf` (`core/config`); `FieldCipher` (`core/security`, `encrypt(plain, aad)`, `decrypt(token, aad)` đồng bộ); `Webhook` (`standardwebhooks`); `WEBHOOK_SECRET_BYTES`, `WEBHOOK_SECRET_PREFIX`, `WEBHOOK_URL_MAX_LENGTH` (Task 4).
- Produces:
  - `type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'INVALID' | 'NOT_ALLOWED' | 'UNRESOLVABLE' }`; `abstract class UrlGuard { abstract check(raw: string): Promise<UrlCheck> }`. `url` là `new URL(raw).href` (giá trị lưu DB).
  - `DnsUrlGuard extends UrlGuard`; token `HOST_RESOLVER`; `type HostResolver = (host: string) => Promise<readonly { address: string; family: number }[]>`; `dnsResolver` (`node:dns/promises` `lookup(host, { all: true })`). Test thay resolver bằng `overrideProvider(HOST_RESOLVER)`.
  - `abstract class WebhookSigner { abstract sign(input: { secrets: readonly string[]; messageId: string; timestamp: Date; body: string }): string }`; `StandardWebhooksSigner`.
  - `WebhookSecrets`: `generate(): string`, `seal(secret, { orgId, secretPublicId }): string`, `open(token, { orgId, secretPublicId }): string`. AAD `webhook_endpoint_secrets:secret_enc:<orgId>:<secretPublicId>` (spec §6.5).
  - Provider của `IntegrationsCoreModule`: `{ provide: HOST_RESOLVER, useValue: dnsResolver }`, `DnsUrlGuard` (`UrlGuard`), `StandardWebhooksSigner` (`WebhookSigner`), `WebhookSecrets`; export `UrlGuard`, `WebhookSigner`, `WebhookSecrets`.

- [ ] **Step 1: Unit test (fail)**

`test/unit/modules/integrations/dns-url-guard.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { resilienceConfig } from '../../../../src/core/resilience/index.js';
import { DnsUrlGuard, type HostResolver } from '../../../../src/modules/integrations/infra/dns-url-guard.js';

const PUBLIC_IP = '93.184.215.14';
/** Resolver giả: `localhost*` → loopback; `private*` → RFC1918; `mixed*` → công khai + `::1`; `nx*` → lỗi DNS như Node; `empty*` → []. */
const resolver: HostResolver = async (host) => {
  if (host.startsWith('localhost')) return [{ address: '127.0.0.1', family: 4 }];
  if (host.startsWith('private')) return [{ address: '10.0.0.5', family: 4 }];
  if (host.startsWith('mixed')) return [{ address: PUBLIC_IP, family: 4 }, { address: '::1', family: 6 }];
  if (host.startsWith('nx')) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  if (host.startsWith('empty')) return [];
  return [{ address: PUBLIC_IP, family: 4 }];
};
const guard = (env: Record<string, string> = {}) =>
  new DnsUrlGuard(resilienceConfig.schema.parse({ allowedSchemes: 'https', allowedPorts: '443', allowCidrs: '', ...env }), resolver);

describe('DnsUrlGuard (spec SP6 §8.3 step 1, W-20, W-21)', () => {
  it('accepts a public https URL and returns its normalised form', async () => {
    expect(await guard().check('https://Hooks.Example.test/a b?x=1')).toEqual({ ok: true, url: 'https://hooks.example.test/a%20b?x=1' });
  });
  it.each([
    'https://127.0.0.1/hook',
    'https://10.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]/hook',
    'https://user:pw@hooks.example.test/hook',
    'https://hooks.example.test:8080/hook',
    'http://hooks.example.test/hook',
  ])('refuses %s (W-20)', async (url) => {
    expect(await guard().check(url)).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
  });
  it('refuses a name that resolves to a private address (W-21)', async () => {
    expect(await guard().check('https://private.example.test/hook')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
  });
  it.each(['https://2130706433/', 'https://0x7f.1/', 'https://127.1/', 'https://[0:0:0:0:0:ffff:7f00:1]/', 'https://LOCALHOST./'])(
    'Review Focus 1: numeric, shortened and trailing-dot hosts are refused: %s',
    async (url) => {
      expect((await guard().check(url)).ok).toBe(false);
    },
  );
  it('Review Focus 2: one private address among public ones is refused; an empty answer too', async () => {
    expect(await guard().check('https://mixed.example.test/hook')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
    expect(await guard().check('https://empty.example.test/')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
  });
  it('a fragment, a malformed URL, a URL that grows past the column limit, and a name that does not resolve are refused', async () => {
    expect(await guard().check('https://hooks.example.test/hook#frag')).toEqual({ ok: false, reason: 'INVALID' });
    expect(await guard().check('not a url')).toEqual({ ok: false, reason: 'INVALID' });
    expect(await guard().check(`https://hooks.example.test/${'é'.repeat(700)}`)).toEqual({ ok: false, reason: 'INVALID' });
    expect(await guard().check('https://nx.example.test/')).toEqual({ ok: false, reason: 'UNRESOLVABLE' });
  });
  it('RESILIENCE_SSRF_ALLOW_CIDRS exempts a private range, as HttpClient does at connect time', async () => {
    expect(await guard({ allowCidrs: '10.0.0.0/24' }).check('https://private.example.test/hook')).toMatchObject({ ok: true });
  });
  it('a resolver failure that is not a DNS error is a bug and is thrown', async () => {
    const broken = new DnsUrlGuard(resilienceConfig.schema.parse({}), async () => {
      throw new TypeError('boom');
    });
    await expect(broken.check('https://hooks.example.test/')).rejects.toThrow('boom');
  });
});
```
`test/unit/modules/integrations/standard-webhooks.signer.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { StandardWebhooksSigner } from '../../../../src/modules/integrations/infra/standard-webhooks.signer.js';

const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const headersOf = (id: string, at: Date, signature: string) => ({
  'webhook-id': id,
  'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
  'webhook-signature': signature,
});

describe('StandardWebhooksSigner (spec SP6 §8.3 step 3, W-1..W-3)', () => {
  const signer = new StandardWebhooksSigner();
  it('one secret: the receiver verifies with new Webhook(secret).verify (W-1)', () => {
    const s = secret();
    const at = new Date();
    const body = '{"type":"tenancy.org.updated","version":1,"timestamp":"t","data":{}}';
    const sig = signer.sign({ secrets: [s], messageId: 'evt-1', timestamp: at, body });
    expect(new Webhook(s).verify(body, headersOf('evt-1', at, sig))).toEqual(JSON.parse(body));
  });
  it('two secrets during the overlap: two space-separated signatures, each secret verifies alone (W-2)', () => {
    const [a, b] = [secret(), secret()];
    const at = new Date();
    const sig = signer.sign({ secrets: [a, b], messageId: 'evt-2', timestamp: at, body: '{}' });
    expect(sig.split(' ')).toHaveLength(2);
    for (const s of [a, b]) expect(() => new Webhook(s).verify('{}', headersOf('evt-2', at, sig))).not.toThrow();
  });
  it('after the overlap only the new secret signs; the old one no longer verifies (W-3)', () => {
    const [oldS, newS] = [secret(), secret()];
    const at = new Date();
    const sig = signer.sign({ secrets: [newS], messageId: 'evt-3', timestamp: at, body: '{}' });
    expect(() => new Webhook(oldS).verify('{}', headersOf('evt-3', at, sig))).toThrow(/No matching signature/);
  });
  it('refuses to sign with no secret (a delivery never goes out unsigned)', () => {
    expect(() => signer.sign({ secrets: [], messageId: 'evt-4', timestamp: new Date(), body: '{}' })).toThrow(/at least one/);
  });
});
```
`test/unit/modules/integrations/webhook-secrets.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher, FieldCipherError } from '../../../../src/core/security/index.js';
import { WebhookSecrets } from '../../../../src/modules/integrations/application/webhook-secrets.js';

const cipher = new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1');
const secrets = new WebhookSecrets(cipher);
const ORG = '0199a000-0000-7000-8000-000000000001';
const SECRET_ID = '0199a000-0000-7000-8000-000000000002';

describe('WebhookSecrets (spec SP6 §6.5, §8.3 step 3, S6-A29)', () => {
  it('generates whsec_ + base64 of 32 random bytes, never twice the same', () => {
    const a = secrets.generate();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice('whsec_'.length), 'base64')).toHaveLength(32);
    expect(secrets.generate()).not.toBe(a);
  });
  it('seal/open round-trips; the token is a FieldCipher token that does not contain the secret', () => {
    const s = secrets.generate();
    const token = secrets.seal(s, { orgId: ORG, secretPublicId: SECRET_ID });
    expect(FieldCipher.isCiphertext(token)).toBe(true);
    expect(token).not.toContain(s.slice('whsec_'.length));
    expect(secrets.open(token, { orgId: ORG, secretPublicId: SECRET_ID })).toBe(s);
  });
  it('the ciphertext is bound to its org and secret row (AAD)', () => {
    const token = secrets.seal(secrets.generate(), { orgId: ORG, secretPublicId: SECRET_ID });
    expect(() => secrets.open(token, { orgId: SECRET_ID, secretPublicId: SECRET_ID })).toThrow(FieldCipherError);
    expect(() => secrets.open(token, { orgId: ORG, secretPublicId: ORG })).toThrow(FieldCipherError);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/integrations/dns-url-guard.spec.ts test/unit/modules/integrations/standard-webhooks.signer.spec.ts test/unit/modules/integrations/webhook-secrets.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Cài**

`src/modules/integrations/ports/url-guard.ts`:
```ts
/** Lý do chỉ để log/metric; client chỉ nhận `422 webhook_url_not_allowed` với detail chung (spec §8.3 bước 1). */
export type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'INVALID' | 'NOT_ALLOWED' | 'UNRESOLVABLE' };

/**
 * Kiểm URL lúc tạo và lúc sửa (spec SP6 §8.3 bước 1). Chỉ để phản hồi sớm: lớp chặn thật là `ssrfLookup` lúc connect của
 * `HttpClient` (DNS rebinding, W-22). Gọi NGOÀI transaction (DNS là I/O ngoài, spec §3.2 luật 3).
 */
export abstract class UrlGuard {
  abstract check(raw: string): Promise<UrlCheck>;
}
```
`src/modules/integrations/ports/webhook-signer.ts`:
```ts
/** Chữ ký Standard Webhooks (spec §8.3 bước 3): mọi secret còn hiệu lực, cách nhau bằng dấu cách, secret hiện hành trước. */
export abstract class WebhookSigner {
  abstract sign(input: { secrets: readonly string[]; messageId: string; timestamp: Date; body: string }): string;
}
```
`src/modules/integrations/infra/dns-url-guard.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConfigOf } from '../../../core/config/index.js';
import { SsrfBlockedError, assertUrlAllowed, isPublicAddress, parseCidrs, resilienceConfig } from '../../../core/resilience/index.js';
import { WEBHOOK_URL_MAX_LENGTH } from '../constants.js';
import { UrlGuard, type UrlCheck } from '../ports/url-guard.js';

export type HostResolver = (host: string) => Promise<readonly { address: string; family: number }[]>;
/** Token của resolver: production dùng DNS hệ thống; test thay bằng resolver giả (W-21, W-22). */
export const HOST_RESOLVER = Symbol('HOST_RESOLVER');
export const dnsResolver: HostResolver = (host) => lookup(host, { all: true });

/** Lỗi DNS của Node (`ENOTFOUND`, `EAI_AGAIN`…) mang `code` chuỗi; lỗi khác là bug, ném tiếp. */
const isDnsError = (err: unknown): boolean => err instanceof Error && 'code' in err && typeof err.code === 'string';

/**
 * Cùng chính sách với `HttpClient` (spec SP6 §8.3 bước 1): `assertUrlAllowed` (scheme, userinfo, port, IP literal), cấm
 * fragment, URL chuẩn hoá còn vừa cột `url`, rồi MỌI địa chỉ phân giải được phải công khai hoặc thuộc
 * `RESILIENCE_SSRF_ALLOW_CIDRS` (Review Focus 2: kiểm "địa chỉ đầu" sẽ lọt).
 */
@Injectable()
export class DnsUrlGuard extends UrlGuard {
  constructor(
    @Inject(resilienceConfig.KEY) private readonly cfg: ConfigOf<typeof resilienceConfig>,
    @Inject(HOST_RESOLVER) private readonly resolve: HostResolver,
  ) {
    super();
  }

  async check(raw: string): Promise<UrlCheck> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'INVALID' };
    }
    if (raw.includes('#') || url.href.length > WEBHOOK_URL_MAX_LENGTH) return { ok: false, reason: 'INVALID' };
    try {
      assertUrlAllowed(url, this.cfg);
    } catch (err) {
      if (err instanceof SsrfBlockedError) return { ok: false, reason: 'NOT_ALLOWED' };
      throw err;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literal đã được `assertUrlAllowed` kiểm (net.connect không gọi lookup cho IP literal).
    if (isIP(host) !== 0) return { ok: true, url: url.href };
    let addresses: readonly { address: string }[];
    try {
      addresses = await this.resolve(host);
    } catch (err) {
      if (isDnsError(err)) return { ok: false, reason: 'UNRESOLVABLE' };
      throw err;
    }
    const allow = parseCidrs(this.cfg.allowCidrs);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address, allow))) return { ok: false, reason: 'NOT_ALLOWED' };
    return { ok: true, url: url.href };
  }
}
```
`src/modules/integrations/infra/standard-webhooks.signer.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { WebhookSigner } from '../ports/webhook-signer.js';

/** Luật kiến trúc 21: `standardwebhooks` chỉ được import ở `integrations/infra`. */
@Injectable()
export class StandardWebhooksSigner extends WebhookSigner {
  sign(input: { secrets: readonly string[]; messageId: string; timestamp: Date; body: string }): string {
    if (input.secrets.length === 0) throw new Error('at least one signing secret is required');
    return input.secrets.map((s) => new Webhook(s).sign(input.messageId, input.timestamp, input.body)).join(' ');
  }
}
```
`src/modules/integrations/application/webhook-secrets.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { FieldCipher } from '../../../core/security/index.js';
import { WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX } from '../constants.js';

type Binding = { orgId: string; secretPublicId: string };
/** AAD của spec §6.5: ciphertext chép sang dòng/org khác thì giải mã thất bại. */
const aadOf = (b: Binding): string => `webhook_endpoint_secrets:secret_enc:${b.orgId}:${b.secretPublicId}`;

/** Secret ký là 256 bit ngẫu nhiên, lưu mã hoá (S6-A29: ký cần secret gốc, không lưu băm); bản rõ chỉ trả một lần. */
@Injectable()
export class WebhookSecrets {
  constructor(private readonly cipher: FieldCipher) {}

  generate(): string {
    return `${WEBHOOK_SECRET_PREFIX}${randomBytes(WEBHOOK_SECRET_BYTES).toString('base64')}`;
  }
  seal(secret: string, b: Binding): string {
    return this.cipher.encrypt(secret, aadOf(b));
  }
  /** `FieldCipherError` (kid đã retire, ciphertext hỏng) ném lên: lỗi vận hành, job fail to (spec §14). */
  open(token: string, b: Binding): string {
    return this.cipher.decrypt(token, aadOf(b));
  }
}
```
`src/modules/integrations/integrations.module.ts`: trong `IntegrationsCoreModule`, thêm vào `providers`:
```ts
    { provide: HOST_RESOLVER, useValue: dnsResolver },
    DnsUrlGuard,
    { provide: UrlGuard, useExisting: DnsUrlGuard },
    StandardWebhooksSigner,
    { provide: WebhookSigner, useExisting: StandardWebhooksSigner },
    WebhookSecrets,
```
vào `exports`: `UrlGuard`, `WebhookSigner`, `WebhookSecrets`; import từ `./infra/dns-url-guard.js`, `./ports/url-guard.js`, `./infra/standard-webhooks.signer.js`, `./ports/webhook-signer.js`, `./application/webhook-secrets.js`.

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations
pnpm typecheck
pnpm arch
```
Expected: PASS; `pnpm arch`: `standardwebhooks` chỉ được import ở `infra/standard-webhooks.signer.ts` (luật 21 sạch trên cây `src`).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/unit/modules/integrations
git add src/modules/integrations test/unit/modules/integrations
git commit -m "feat(integrations): SSRF URL guard at registration, Standard Webhooks signer with overlapping secrets, sealed signing secrets bound to their row"
```

---

### Task 8: Tạo, liệt kê, đọc endpoint và catalog event type — repository, `EndpointService`, controller; giới hạn dưới khoá org (R6-26); secret trả một lần

**Files:**
- Create: `src/modules/integrations/ports/endpoint-repository.ts`, `src/modules/integrations/infra/sql/sql-endpoint.repository.ts`, `src/modules/integrations/application/actor.ts`, `src/modules/integrations/application/endpoint.service.ts`, `src/modules/integrations/http/schemas.ts`, `src/modules/integrations/http/webhook-endpoints.controller.ts`, `src/modules/integrations/http/event-types.controller.ts`, `test/support/integrations-app.ts`, `test/e2e/integrations/endpoints-create.e2e.spec.ts`, `test/unit/modules/integrations/schemas.spec.ts`
- Modify: `src/modules/integrations/integrations.module.ts`, `openapi.json` (sinh lại)

**Interfaces:**
- Consumes: `OrgMutationLock.lock(): Promise<boolean>` (tenancy index); `WebhookPermissions.require` (Task 5); `SessionOnly`, `RequireFreshSession`, `RequireVerifiedEmail` (identity index); `UrlGuard`, `WebhookSecrets`, `HOST_RESOLVER`, `type HostResolver` (Task 7); `WebhookEventCatalogueCheck.known()/definitions()` (Task 6); `EndpointCreatedEvent`, `IntegrationsErrors`, `integrationsConfig` (Task 5); `Db`, `UnitOfWork`, `countUpTo` (`core/database`); `EventPublisher` (`core/events`); `RequestContext` (`core/context`); `Paginator`, `offsetPageQuery`, `offsetPageSchema`, `paginationConfig`, `ApiOk`, `ApiProblems`, `etagOf`, `serialize`, `setLocation`, `type HeaderWriter` (`core/http`); `AppError`, `CoreErrors` (`core/errors`); `IdentityErrors` (identity index); `FlagsModule`, `SweepModule`; test: `startTenancyApp`, `authed`, `seedUserPrincipal`, `deleteSeededPrincipals`, `seedOrg`, `seedMember`, `raceOnOrgLock`, `ownerQuery`, `orgQuery` (Task 2).
- Produces:
  - `type EndpointRow = { id: string; publicId: string; url: string; description: string | null; status: EndpointStatus; disabledReason: DisabledReason | null; failingSince: Date | null; version: number; createdAt: Date; updatedAt: Date; eventTypes: string[] }`; `type EndpointLock = 'NONE' | 'NO_KEY_UPDATE' | 'SHARE'`.
  - `abstract class EndpointRepository` với `countLive(): Promise<number>`, `countLiveUpTo(cap): Promise<number>`, `insert({ url, description }): Promise<{ id: string; publicId: string }>`, `setEventTypes(endpointId, types): Promise<void>`, `insertSecret({ endpointId, publicId, secretEnc }): Promise<void>`, `list({ limit, offset }): Promise<EndpointRow[]>`, `find(publicId, lock): Promise<EndpointRow | undefined>` (chỉ endpoint chưa xoá). Task 9, 11, 13 thêm phương thức.
  - `SqlEndpointRepository extends EndpointRepository`.
  - `userActor(ctx): EventActor` (`application/actor.ts`).
  - `EndpointService.create(body): Promise<{ endpoint: EndpointRow; secret: string }>`, `.list(page): Promise<{ rows: EndpointRow[]; total: number }>`, `.get(publicId): Promise<EndpointRow>`, `.checkedUrl(raw): Promise<string>`, `.knownTypes(types): string[]` (bỏ trùng, sắp theo thứ tự byte — cùng thứ tự với `COLLATE "C"` của `ENDPOINT_COLUMNS`, M3; trần lúc chạy `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT`, M7).
  - `byteOrder(a, b): number` (`domain/webhook-endpoint.ts`, thêm ở task này): so sánh chuỗi theo code unit, bằng thứ tự byte với event type ASCII (`WEBHOOK_EVENT_TYPE_PATTERN`).
  - HTTP: `CreateEndpointBody`, `EndpointListPage`, `WebhookEndpointResponse`, `CreatedWebhookEndpointResponse`, `endpointOf(row)`, `EventTypeListResponse`, `endpointIdOrNotFound(raw)`; route `POST/GET /v1/orgs/:orgId/webhook-endpoints`, `GET …/:endpointId`, `GET /v1/webhook-event-types`.
  - `test/support/integrations-app.ts`: `PUBLIC_IP`, `fixedResolver(overrides?)`, `startIntegrationsApp(opts?)` (api + worker trong một process; `opts.consumeWebhooks` bật consume queue `webhooks-out`), `integrationsCoreImports(extra?)` (worker, không HTTP), `endpointsUrl(orgId)`.

- [ ] **Step 1: Test e2e (fail)**

`test/support/integrations-app.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { FlagsModule } from '../../src/core/flags/index.js';
import { SweepModule } from '../../src/core/sweep/index.js';
import { HOST_RESOLVER, type HostResolver } from '../../src/modules/integrations/infra/dns-url-guard.js';
import { IntegrationsModule } from '../../src/modules/integrations/index.js';
import type { ConfigureTestingModule, ModuleImport } from './app-factory.js';
import { startTenancyApp } from './tenancy-app.js';
import { tenancyCoreImports } from './tenancy-core-app.js';

/** IP công khai thật (không bao giờ được kết nối trong test: resolver giả chỉ dùng ở `UrlGuard`). */
export const PUBLIC_IP = '93.184.215.14';
/** Resolver giả của `UrlGuard`: mọi tên ra `PUBLIC_IP`, trừ tên trong `overrides`. */
export const fixedResolver =
  (overrides: Record<string, readonly string[]> = {}): HostResolver =>
  async (host) =>
    (overrides[host] ?? [PUBLIC_IP]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
export const endpointsUrl = (orgId: string): string => `/v1/orgs/${orgId}/webhook-endpoints`;

export type IntegrationsAppOpts = {
  env?: Record<string, string>;
  resolver?: HostResolver;
  configure?: ConfigureTestingModule;
  extraImports?: ModuleImport[];
  /** Mặc định `false`: test gọi handler gửi trực tiếp (tất định). `true`: worker của app consume `webhooks-out` (luồng thật). */
  consumeWebhooks?: boolean;
};

/**
 * App e2e của tenancy (api + worker events/notifications) + `FlagsModule`, `SweepModule` + `IntegrationsModule.forApi()` và
 * `.forWorker()` trong một process (mẫu `startEntitlementsApp`). `HOST_RESOLVER` luôn bị thay bằng resolver giả: test không
 * bao giờ phân giải DNS thật.
 */
export function startIntegrationsApp(opts: IntegrationsAppOpts = {}): Promise<INestApplication> {
  const resolver = opts.resolver ?? fixedResolver();
  return startTenancyApp({
    env: { ...(opts.consumeWebhooks ? { WORKER_QUEUES: 'events,notifications,webhooks-out' } : {}), ...opts.env },
    configure: (b) => {
      const withResolver = b.overrideProvider(HOST_RESOLVER).useValue(resolver);
      return opts.configure ? opts.configure(withResolver) : withResolver;
    },
    extraImports: [FlagsModule, SweepModule, IntegrationsModule.forApi(), IntegrationsModule.forWorker(), ...(opts.extraImports ?? [])],
  });
}

/** Hạ tầng core + tenancy (worker) + integrations worker, không HTTP: handler, participant, sweep. */
export const integrationsCoreImports = (extra: ModuleImport[] = []): ModuleImport[] => [
  ...tenancyCoreImports(),
  FlagsModule,
  SweepModule,
  IntegrationsModule.forWorker(),
  ...extra,
];
```
`test/e2e/integrations/endpoints-create.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { endpointsUrl, fixedResolver, startIntegrationsApp } from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const LIMIT = 3;
const TYPES_CAP = 2;
const STALE_SEC = 86_400;
const body = (url = `https://hooks.example.test/${Math.random()}`) => ({ url, eventTypes: ['tenancy.org.updated', 'tenancy.org.updated'] });

describe('create, list and read webhook endpoints (spec SP6 §8.3, §9.2, R6-26)', () => {
  let app: INestApplication;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let stale: SeededPrincipal;
  let org: SeededOrg;
  const people: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startIntegrationsApp({
      // M7: env chỉ hạ trần lúc chạy; schema/OpenAPI giữ WEBHOOK_EVENT_TYPES_MAX (test unit `schemas.spec.ts`).
      env: { INTEGRATIONS_MAX_ENDPOINTS_PER_ORG: String(LIMIT), INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT: String(TYPES_CAP) },
      resolver: fixedResolver({ 'private.example.test': ['10.0.0.5'] }),
    });
    owner = await seedUserPrincipal();
    member = await seedUserPrincipal();
    stale = await seedUserPrincipal({ sessionAgeSec: STALE_SEC });
    people.push(owner, member, stale);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await seedMember(org, 'ADMIN', { authUserId: stale.authUserId });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(people);
  });

  it('201 + Location + ETag; the secret comes once, no-store; event types are deduplicated; one audited created event with only the host', async () => {
    const res = await authed(app, owner).post(endpointsUrl(org.orgId)).send({ ...body('https://hooks.example.test/a?token=t'), description: 'Main' });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`${endpointsUrl(org.orgId)}/${res.body.id}`);
    expect(res.headers.etag).toBe('W/"1"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      url: 'https://hooks.example.test/a?token=t',
      description: 'Main',
      eventTypes: ['tenancy.org.updated'],
      status: 'ACTIVE',
      disabledReason: null,
      failingSince: null,
    });
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const [secretRow] = await orgQuery<{ secret_enc: string; expires_at: Date | null }>(
      org.orgId,
      `SELECT s.secret_enc, s.expires_at FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [res.body.id],
    );
    expect(secretRow?.secret_enc).toMatch(/^v1\./);
    expect(secretRow?.secret_enc).not.toContain(String(res.body.secret).slice('whsec_'.length));
    expect(secretRow?.expires_at).toBeNull();
    const events = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.endpoint.created' AND payload->>'endpointId' = $2`,
      [org.orgId, res.body.id],
    );
    expect(events.map((e) => e.payload)).toEqual([{ endpointId: res.body.id, urlHost: 'hooks.example.test', eventTypes: ['tenancy.org.updated'] }]);
    const get = await authed(app, owner).get(`${endpointsUrl(org.orgId)}/${res.body.id}`);
    expect(get.status).toBe(200);
    expect(get.headers.etag).toBe('W/"1"');
    expect(get.body).not.toHaveProperty('secret');
  });
  it.each([
    ['a private address', 'https://private.example.test/x'],
    ['a loopback literal', 'https://127.0.0.1/x'],
    ['http in a https-only setup', 'http://hooks.example.test/x'],
  ])('422 webhook_url_not_allowed for %s, with a generic detail and no IP', async (_name, url) => {
    const res = await authed(app, owner).post(endpointsUrl(org.orgId)).send(body(url));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('webhook_url_not_allowed');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
  it('422 webhook_event_type_unknown names the unknown type under errors; a type that is not a webhook event is unknown too', async () => {
    const res = await authed(app, owner).post(endpointsUrl(org.orgId)).send({ url: 'https://hooks.example.test/u', eventTypes: ['tenancy.org.created'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('webhook_event_type_unknown');
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'eventTypes', code: 'tenancy.org.created' })]);
  });
  it('M7: more distinct event types than INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT is 422 validation_failed on eventTypes; duplicates do not count', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({ url: 'https://hooks.example.test/cap', eventTypes: ['tenancy.org.updated', 'tenancy.member.added', 'tenancy.member.removed'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'eventTypes' })]);
  });
  it('M3: event types come back in byte order, the same order the DB aggregates with COLLATE "C"', async () => {
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({ url: 'https://hooks.example.test/order', eventTypes: ['tenancy.org.updated', 'tenancy.member.added'] });
    expect(res.status).toBe(201);
    expect(res.body.eventTypes).toEqual(['tenancy.member.added', 'tenancy.org.updated']);
    expect((await authed(app, owner).get(`${endpointsUrl(org.orgId)}/${res.body.id}`)).body.eventTypes).toEqual(res.body.eventTypes);
  });
  it('a member without webhooks.write gets 403; a stale session gets 403 reauthentication_required', async () => {
    expect((await authed(app, member).post(endpointsUrl(org.orgId)).send(body())).status).toBe(403);
    const res = await authed(app, stale).post(endpointsUrl(org.orgId)).send(body());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauthentication_required');
  });
  it('R6-26: LIMIT + 2 creations queued on the org lock give exactly the remaining slots, the rest 422 webhook_endpoints_limit', async () => {
    const [{ n: before } = { n: 0 }] = await orgQuery<{ n: number }>(org.orgId, `SELECT count(*)::int AS n FROM webhook_endpoints WHERE deleted_at IS NULL`);
    const tries = LIMIT - before + 2;
    const results = await raceOnOrgLock(org.orgId, tries, () =>
      Promise.all(Array.from({ length: tries }, () => authed(app, owner).post(endpointsUrl(org.orgId)).send(body()))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(LIMIT - before);
    expect(statuses.filter((s) => s === 422)).toHaveLength(2);
    for (const r of results.filter((x) => x.status === 422)) expect(r.body.code).toBe('webhook_endpoints_limit');
    const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(org.orgId, `SELECT count(*)::int AS n FROM webhook_endpoints WHERE deleted_at IS NULL`);
    expect(n).toBe(LIMIT);
  });
  it('list is offset-paginated, oldest first, without secrets; an unknown or malformed id is 404', async () => {
    const res = await authed(app, member).get(`${endpointsUrl(org.orgId)}?page=1&pageSize=2`);
    expect(res.status).toBe(403); // MEMBER không có webhooks.read (grantTo.member = false)
    const own = await authed(app, owner).get(`${endpointsUrl(org.orgId)}?page=1&pageSize=2`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ page: 1, pageSize: 2, totalCount: LIMIT, hasMore: true });
    expect(own.body.data).toHaveLength(2);
    for (const e of own.body.data) expect(e).not.toHaveProperty('secret');
    expect((await authed(app, owner).get(`${endpointsUrl(org.orgId)}/not-a-uuid`)).status).toBe(404);
    expect((await authed(app, owner).get(`${endpointsUrl(org.orgId)}/0199a000-0000-7000-8000-000000000000`)).status).toBe(404);
  });
  it('GET /v1/webhook-event-types lists the code catalogue with the JSON Schema of each payload, for any signed-in user', async () => {
    const res = await authed(app, member).get('/v1/webhook-event-types');
    expect(res.status).toBe(200);
    const types = res.body.data.map((d: { type: string; version: number }) => `${d.type}@${d.version}`);
    expect(types).toEqual(expect.arrayContaining(['tenancy.org.updated@1', 'tenancy.member.added@1']));
    const updated = res.body.data.find((d: { type: string }) => d.type === 'tenancy.org.updated');
    expect(updated.schema).toMatchObject({ type: 'object', required: expect.arrayContaining(['orgId', 'changed']) });
  });
});
```
(Ca R6-26 đếm `before` từ DB nên hai ca M3/M7 đứng trước nó không làm lệch: M7 không tạo gì, M3 tạo một endpoint và `tries` tự tính lại.)

`test/unit/modules/integrations/schemas.spec.ts` (M7: hợp đồng công khai không phụ thuộc env của máy export):
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES_MAX } from '../../../../src/modules/integrations/constants.js';

describe('webhook endpoint schemas (review 6C M7)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('eventTypes maxItems is WEBHOOK_EVENT_TYPES_MAX even when the runtime cap is lowered by env', async () => {
    vi.stubEnv('INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT', '2');
    vi.resetModules();
    const { CreateEndpointBody } = await import('../../../../src/modules/integrations/http/schemas.js');
    for (const s of [CreateEndpointBody])
      expect(z.toJSONSchema(s, { io: 'input' })).toMatchObject({ properties: { eventTypes: { maxItems: WEBHOOK_EVENT_TYPES_MAX } } });
  });
});
```
(Task 9 thêm `PatchEndpointDestinationBody` vào import và vào mảng.)

Run:
```bash
pnpm vitest run --project integration test/e2e/integrations/endpoints-create.e2e.spec.ts
pnpm vitest run --project unit test/unit/modules/integrations/schemas.spec.ts
```
Expected: FAIL (route chưa có → 404; `schemas.js` chưa có).

- [ ] **Step 2: Repository**

`src/modules/integrations/ports/endpoint-repository.ts`:
```ts
import type { DisabledReason, EndpointStatus } from '../domain/webhook-endpoint.js';

export type EndpointRow = {
  /** id BIGINT nội bộ (text), không bao giờ ra API. */
  id: string;
  publicId: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  disabledReason: DisabledReason | null;
  failingSince: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  eventTypes: string[];
};
/** `NO_KEY_UPDATE`: sửa/xoá/xoay; `SHARE`: retry/recover/test (chặn tắt endpoint giữa lúc đưa delivery về PENDING). */
export type EndpointLock = 'NONE' | 'NO_KEY_UPDATE' | 'SHARE';

/** Mọi phương thức chạy trong OrgScope của caller (RLS); phương thức ghi chạy trong `UnitOfWork.run` của caller. */
export abstract class EndpointRepository {
  abstract countLive(): Promise<number>;
  abstract countLiveUpTo(cap: number): Promise<number>;
  abstract insert(i: { url: string; description: string | null }): Promise<{ id: string; publicId: string }>;
  abstract setEventTypes(endpointId: string, types: readonly string[]): Promise<void>;
  abstract insertSecret(i: { endpointId: string; publicId: string; secretEnc: string }): Promise<void>;
  abstract list(page: { limit: number; offset: number }): Promise<EndpointRow[]>;
  /** Chỉ endpoint chưa xoá mềm. */
  abstract find(publicId: string, lock: EndpointLock): Promise<EndpointRow | undefined>;
}
```
`src/modules/integrations/infra/sql/sql-endpoint.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { DISABLED_REASONS, ENDPOINT_STATUSES } from '../../domain/webhook-endpoint.js';
import { EndpointRepository, type EndpointLock, type EndpointRow } from '../../ports/endpoint-repository.js';

export const ENDPOINT_COLUMNS = `e.id::text AS id, e.public_id::text AS public_id, e.url, e.description, e.status, e.disabled_reason,
  e.failing_since, e.version, e.created_at, e.updated_at,
  COALESCE((SELECT array_agg(t.event_type ORDER BY t.event_type COLLATE "C") FROM webhook_endpoint_event_types t
            WHERE t.org_id = e.org_id AND t.endpoint_id = e.id), '{}') AS event_types`;
const Row = z.object({
  id: z.string(),
  public_id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  status: z.enum(ENDPOINT_STATUSES),
  disabled_reason: z.enum(DISABLED_REASONS).nullable(),
  failing_since: z.coerce.date().nullable(),
  version: z.number().int(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  event_types: z.array(z.string()),
});
export const toEndpointRow = (raw: unknown): EndpointRow => {
  const r = Row.parse(raw);
  return {
    id: r.id,
    publicId: r.public_id,
    url: r.url,
    description: r.description,
    status: r.status,
    disabledReason: r.disabled_reason,
    failingSince: r.failing_since,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    eventTypes: r.event_types,
  };
};
const lockClause = (lock: EndpointLock): string => {
  switch (lock) {
    case 'NONE':
      return '';
    case 'NO_KEY_UPDATE':
      return ' FOR NO KEY UPDATE OF e';
    case 'SHARE':
      return ' FOR SHARE OF e';
    default: {
      const unreachable: never = lock;
      throw new Error(`Unhandled endpoint lock ${String(unreachable)}`);
    }
  }
};
const LIVE = `e.org_id = app_current_org() AND e.deleted_at IS NULL`;
const IdRow = z.array(z.object({ id: z.string(), public_id: z.uuid() }));
const CountRow = z.array(z.object({ n: z.number().int() }));

@Injectable()
export class SqlEndpointRepository extends EndpointRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async countLive(): Promise<number> {
    const [r] = CountRow.parse(
      await this.db.execute(`SELECT count(*)::int AS n FROM webhook_endpoints e WHERE ${LIVE}`),
    );
    if (!r) throw new Error('count of webhook endpoints returned no row');
    return r.n;
  }
  countLiveUpTo(cap: number): Promise<number> {
    return countUpTo(this.db, `SELECT 1 FROM webhook_endpoints e WHERE ${LIVE}`, [], cap);
  }
  async insert(i: { url: string; description: string | null }): Promise<{ id: string; publicId: string }> {
    const [r] = IdRow.parse(
      await this.db.execute(
        `INSERT INTO webhook_endpoints (org_id, url, description) VALUES (app_current_org(), ?, ?) RETURNING id::text AS id, public_id::text AS public_id`,
        [i.url, i.description],
      ),
    );
    if (!r) throw new Error('webhook endpoint insert returned no row');
    return { id: r.id, publicId: r.public_id };
  }
  async setEventTypes(endpointId: string, types: readonly string[]): Promise<void> {
    // `ARRAY[]::text[]` của tập rỗng là lỗi cú pháp; zod đã đòi `min(1)`, tới đây với tập rỗng là bug.
    if (types.length === 0) throw new Error('setEventTypes needs at least one event type');
    await this.db.execute(
      `DELETE FROM webhook_endpoint_event_types WHERE org_id = app_current_org() AND endpoint_id = ?::bigint AND event_type <> ALL(ARRAY[?]::text[])`,
      [endpointId, types],
    );
    await this.db.execute(
      `INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type)
       SELECT app_current_org(), ?::bigint, t FROM unnest(ARRAY[?]::text[]) AS t ON CONFLICT DO NOTHING`,
      [endpointId, types],
    );
  }
  async insertSecret(i: { endpointId: string; publicId: string; secretEnc: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO webhook_endpoint_secrets (public_id, org_id, endpoint_id, secret_enc) VALUES (?::uuid, app_current_org(), ?::bigint, ?)`,
      [i.publicId, i.endpointId, i.secretEnc],
    );
  }
  async list(page: { limit: number; offset: number }): Promise<EndpointRow[]> {
    return (
      await this.db.execute(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE ${LIVE} ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`, [
        page.limit,
        page.offset,
      ])
    ).map(toEndpointRow);
  }
  async find(publicId: string, lock: EndpointLock): Promise<EndpointRow | undefined> {
    const [r] = await this.db.execute(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE ${LIVE} AND e.public_id = ?::uuid${lockClause(lock)}`, [
      publicId,
    ]);
    return r ? toEndpointRow(r) : undefined;
  }
}
```
(Mảng bind `ARRAY[?]::text[]` theo bài học knex: driver trải mảng JS thành danh sách tham số. M3: `COLLATE "C"` là thứ tự byte, không theo collation của database (`en_US.UTF-8` sắp `_` khác byte order); service sắp bằng `byteOrder`, nên so sánh "tập event type có đổi không" ở Task 9 không bao giờ thấy thay đổi giả.)

`src/modules/integrations/domain/webhook-endpoint.ts`: thêm
```ts
/**
 * Thứ tự byte (M3): `<`/`>` của JS so code unit UTF-16, trùng thứ tự byte UTF-8 với chuỗi ASCII như event type
 * (`WEBHOOK_EVENT_TYPE_PATTERN`), và trùng `COLLATE "C"` của Postgres. Không dùng `localeCompare` (phụ thuộc ICU/locale).
 */
export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
```

- [ ] **Step 3: Service**

`src/modules/integrations/application/actor.ts`:
```ts
import type { RequestContext } from '../../../core/context/index.js';
import type { EventActor } from '../../../core/events/index.js';

/**
 * Actor của thao tác trực tiếp của user (mẫu `userActor` của tenancy): `webhooks.write` không `apiKeyEligible`, không
 * `supportEligible`, nên principal khác user tới được đây là lỗi lắp ráp: ném to.
 */
export function userActor(ctx: RequestContext): EventActor {
  const p = ctx.principal();
  if (!p) throw new Error('an integrations mutation ran without a principal');
  if (p.type !== 'user') throw new Error(`an integrations mutation ran with a ${p.type} principal`);
  return { type: 'user', id: p.id };
}
```
`src/modules/integrations/application/endpoint.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { OrgMutationLock } from '../../tenancy/index.js';
import { ENDPOINT_AGGREGATE } from '../constants.js';
import { byteOrder, urlHost } from '../domain/webhook-endpoint.js';
import { IntegrationsErrors } from '../errors.js';
import { EndpointCreatedEvent } from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import { EndpointRepository, type EndpointRow } from '../ports/endpoint-repository.js';
import { UrlGuard } from '../ports/url-guard.js';
import { userActor } from './actor.js';
import { WebhookEventCatalogueCheck } from './event-catalogue-check.js';
import { WebhookSecrets } from './webhook-secrets.js';

const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/** Spec SP6 §8.3 "Đăng ký endpoint", "Các thao tác khác". Chạy trong OrgScope của route tenant (SP3 §7). */
@Injectable()
export class EndpointService {
  private readonly logger = new Logger(EndpointService.name);
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly endpoints: EndpointRepository,
    private readonly urls: UrlGuard,
    private readonly secrets: WebhookSecrets,
    private readonly catalogue: WebhookEventCatalogueCheck,
    private readonly orgLock: OrgMutationLock,
    private readonly events: EventPublisher,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  /** Bước 1 (spec §8.3): NGOÀI transaction (DNS là I/O ngoài). Lý do chỉ vào log; client nhận detail chung. */
  async checkedUrl(raw: string): Promise<string> {
    const r = await this.urls.check(raw);
    if (r.ok) return r.url;
    this.logger.warn({ event: 'webhook_url_refused', reason: r.reason }, 'webhook URL refused at registration');
    throw new AppError(IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED, {
      detail: 'The URL must be a public https URL without credentials or fragment, on an allowed port.',
      expected: true,
    });
  }

  /**
   * Bước 2: bỏ trùng, sắp theo thứ tự byte (M3); quá trần lúc chạy → 422 `validation_failed` (M7: schema giữ trần cứng
   * `WEBHOOK_EVENT_TYPES_MAX`, env chỉ hạ); type ngoài catalog code ∩ DB → 422, mỗi type lạ một mục ở `errors`.
   */
  knownTypes(types: readonly string[]): string[] {
    const known = this.catalogue.known();
    const unique = [...new Set(types)].sort(byteOrder);
    if (unique.length > this.cfg.maxEventTypesPerEndpoint)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [{ path: 'eventTypes', code: 'too_big', message: `At most ${this.cfg.maxEventTypesPerEndpoint} event types per endpoint` }],
        expected: true,
      });
    const unknown = unique.filter((t) => !known.has(t));
    if (unknown.length > 0)
      throw new AppError(IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN, {
        fields: unknown.map((t) => ({ path: 'eventTypes', code: t, message: IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN.title })),
        expected: true,
      });
    return unique;
  }

  async create(body: { url: string; description?: string; eventTypes: readonly string[] }): Promise<{ endpoint: EndpointRow; secret: string }> {
    const url = await this.checkedUrl(body.url);
    const types = this.knownTypes(body.eventTypes);
    const orgId = this.orgId();
    // Sinh ngoài transaction: `UnitOfWork` có thể chạy lại thân (40001/40P01), secret trả về phải đúng secret đã lưu.
    const secret = this.secrets.generate();
    const secretPublicId = v7();
    const endpoint = await this.uow.run(async () => {
      // R6-26: khoá dòng org rồi mới đếm (cùng điểm tuần tự hoá và thứ tự khoá của SP3 §8.6, S6-A46).
      if (!(await this.orgLock.lock())) throw notFound();
      if ((await this.endpoints.countLive()) >= this.cfg.maxEndpointsPerOrg)
        throw new AppError(IntegrationsErrors.WEBHOOK_ENDPOINTS_LIMIT, { expected: true });
      const created = await this.endpoints.insert({ url, description: body.description ?? null });
      await this.endpoints.setEventTypes(created.id, types);
      await this.endpoints.insertSecret({ endpointId: created.id, publicId: secretPublicId, secretEnc: this.secrets.seal(secret, { orgId, secretPublicId }) });
      const row = await this.endpoints.find(created.publicId, 'NONE');
      if (!row) throw new Error('webhook endpoint vanished inside its creating transaction');
      await this.events.publish(EndpointCreatedEvent, {
        data: { endpointId: row.publicId, urlHost: urlHost(row.url), eventTypes: row.eventTypes },
        aggregate: { type: ENDPOINT_AGGREGATE, id: row.publicId, version: row.version },
        actor: userActor(this.ctx),
      });
      return row;
    });
    return { endpoint, secret };
  }

  async list(page: { page: number; pageSize: number; cap: number }): Promise<{ rows: EndpointRow[]; total: number }> {
    return this.uow.run(async () => ({
      rows: await this.endpoints.list({ limit: page.pageSize, offset: (page.page - 1) * page.pageSize }),
      total: await this.endpoints.countLiveUpTo(page.cap),
    }));
  }

  async get(publicId: string): Promise<EndpointRow> {
    const row = await this.uow.run(() => this.endpoints.find(publicId, 'NONE'));
    if (!row) throw notFound();
    return row;
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined) throw new Error('EndpointService ran without an org context');
    return id;
  }
}
```
(Chèn `integrationsConfig.KEY` theo mẫu `@Inject(paginationConfig.KEY)` của tenancy.)

- [ ] **Step 4: HTTP**

`src/modules/integrations/http/schemas.ts`:
```ts
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { offsetPageQuery, offsetPageSchema } from '../../../core/http/index.js';
import {
  WEBHOOK_DESCRIPTION_MAX_LENGTH, WEBHOOK_EVENT_TYPES_MAX, WEBHOOK_EVENT_TYPE_PATTERN, WEBHOOK_URL_MAX_LENGTH, WEBHOOK_URL_MIN_LENGTH,
} from '../constants.js';
import { DISABLED_REASONS, ENDPOINT_STATUSES } from '../domain/webhook-endpoint.js';
import type { EndpointRow } from '../ports/endpoint-repository.js';

const iso = z.iso.datetime();
const url = z.string().min(WEBHOOK_URL_MIN_LENGTH).max(WEBHOOK_URL_MAX_LENGTH);
// Cùng luật với `webhook_endpoints_description_ck` (`btrim`, 1–500).
const description = z.string().trim().min(1).max(WEBHOOK_DESCRIPTION_MAX_LENGTH);
/**
 * M7: trần cứng có tên, không đọc config lúc import — `openapi.json` (`maxItems`) giống nhau ở mọi máy export và `oasdiff`
 * không thấy thay đổi giả khi env khác. Trần thấp hơn của người vận hành do `EndpointService.knownTypes` kiểm lúc chạy.
 * Không dùng cách `paginationConfig` (đọc config lúc dựng schema): hợp đồng công khai không được phụ thuộc env.
 */
const eventTypes = z.array(z.string().regex(WEBHOOK_EVENT_TYPE_PATTERN)).min(1).max(WEBHOOK_EVENT_TYPES_MAX);

export const CreateEndpointBody = z.object({ url, description: description.optional(), eventTypes }).strict();
export const EndpointListPage = offsetPageQuery({ sortable: ['createdAt'] as const });

export const WebhookEndpointResponse = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  status: z.enum(ENDPOINT_STATUSES),
  disabledReason: z.enum(DISABLED_REASONS).nullable(),
  failingSince: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const CreatedWebhookEndpointResponse = WebhookEndpointResponse.extend({ secret: z.string() });
export const WebhookEndpointPage = offsetPageSchema(WebhookEndpointResponse);
export const endpointOf = (r: EndpointRow): z.infer<typeof WebhookEndpointResponse> => ({
  id: r.publicId,
  url: r.url,
  description: r.description,
  eventTypes: r.eventTypes,
  status: r.status,
  disabledReason: r.disabledReason,
  failingSince: r.failingSince?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
export const EventTypeListResponse = z.object({
  data: z.array(z.object({ type: z.string(), version: z.number().int(), schema: z.record(z.string(), z.unknown()) })),
});

const PublicId = z.uuid();
/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
export const publicIdOrNotFound = (raw: string): string => {
  const r = PublicId.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
```
`src/modules/integrations/http/webhook-endpoints.controller.ts`:
```ts
import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Paginator, etagOf, paginationConfig, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { IdentityErrors, RequireFreshSession, RequireVerifiedEmail, SessionOnly } from '../../identity/index.js';
import { EndpointService } from '../application/endpoint.service.js';
import { IntegrationsErrors } from '../errors.js';
import { WebhookPermissions } from '../permissions.js';
import {
  CreateEndpointBody, CreatedWebhookEndpointResponse, EndpointListPage, WebhookEndpointPage, WebhookEndpointResponse, endpointOf, publicIdOrNotFound,
} from './schemas.js';

/** Spec SP6 §9.2. Org từ path qua pipeline SP3 §7 (OrgScope mở sẵn). */
@Controller('v1/orgs/:orgId/webhook-endpoints')
export class WebhookEndpointsController {
  constructor(
    private readonly endpoints: EndpointService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  /** Không `@Idempotent()`: body trả secret và idempotency lưu body vào Redis (S3-A8). Session mới (S6-A35). */
  @Post()
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(CreatedWebhookEndpointResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED,
    IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
    IntegrationsErrors.WEBHOOK_ENDPOINTS_LIMIT,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(@Body({ schema: CreateEndpointBody }) body: z.infer<typeof CreateEndpointBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const { endpoint, secret } = await this.endpoints.create(body);
    setLocation(res, `/v1/orgs/${this.orgId()}/webhook-endpoints/${endpoint.publicId}`);
    res.setHeader('ETag', etagOf(endpoint.version));
    // Secret một lần: không cache ở proxy/trình duyệt.
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedWebhookEndpointResponse, { ...endpointOf(endpoint), secret });
  }

  @Get()
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookEndpointPage)
  async list(@Query({ schema: EndpointListPage }) page: z.infer<typeof EndpointListPage>) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.endpoints.list({ page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(
      rows.map((r) => serialize(WebhookEndpointResponse, endpointOf(r))),
      page,
      total,
    );
  }

  @Get(':endpointId')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(CoreErrors.NOT_FOUND)
  async get(@Param('endpointId') endpointId: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const row = await this.endpoints.get(publicIdOrNotFound(endpointId));
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined) throw new Error('WebhookEndpointsController ran without an org context');
    return id;
  }
}
```
`src/modules/integrations/http/event-types.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { WebhookEventCatalogueCheck } from '../application/event-catalogue-check.js';
import { EventTypeListResponse } from './schemas.js';

/** JSON Schema 2020-12, cùng dialect với OpenAPI 3.1 của `buildOpenApi`. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

/** Spec SP6 §8.3 "Hợp đồng công khai": catalog kèm JSON Schema của `data`. Cần principal (AuthGuard), không cần org. */
@Controller('v1/webhook-event-types')
export class EventTypesController {
  constructor(private readonly catalogue: WebhookEventCatalogueCheck) {}

  @Get()
  @ApiOk(EventTypeListResponse)
  list() {
    const data = this.catalogue.definitions().map((d) => ({
      type: d.type,
      version: d.version,
      schema: z.toJSONSchema(d.schema, { target: JSON_SCHEMA_TARGET, io: 'output' }),
    }));
    return serialize(EventTypeListResponse, { data });
  }
}
```
`src/modules/integrations/integrations.module.ts`:
- `IntegrationsCoreModule.providers` thêm `SqlEndpointRepository`, `{ provide: EndpointRepository, useExisting: SqlEndpointRepository }`; `exports` thêm `EndpointRepository`.
- `IntegrationsHttpModule`: `controllers: [WebhookEndpointsController, EventTypesController]`, `providers: [EndpointService]`.

- [ ] **Step 5: Chạy, sinh lại OpenAPI**

Run:
```bash
pnpm vitest run --project integration test/e2e/integrations/endpoints-create.e2e.spec.ts
pnpm vitest run --project unit test/unit/modules/integrations/schemas.spec.ts
pnpm typecheck && pnpm arch
pnpm build && pnpm openapi:export && git diff --stat openapi.json
grep -c '"maxItems": 50' openapi.json
```
Expected: PASS mọi ca (ca R6-26: số `201` đúng bằng số slot còn lại, hai `422`, đếm cuối = `LIMIT`); `OrgRouteInventory` của tenancy chấp nhận ba route mới (route tenant có decorator quyền; không phải controller của tenancy nên không cần marker 3A); `openapi.json` thêm ba path; `maxItems` của `eventTypes` là `50` (grep ≥ 1).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/support/integrations-app.ts test/e2e/integrations
git add src/modules/integrations test/support/integrations-app.ts test/e2e/integrations/endpoints-create.e2e.spec.ts test/unit/modules/integrations/schemas.spec.ts openapi.json
git commit -m "feat(integrations): create, list and read webhook endpoints under the org lock, one-time secret, public event type catalogue"
```

---

### Task 9: Sửa (`If-Match`, merge-patch; đổi đích là route riêng có session mới, R-X34), xoá mềm, xoay secret có chồng lấn; event `updated`/`enabled`/`disabled`/`deleted`/`secret_rotated` — Review Focus 4

**Files:**
- Modify: `src/modules/integrations/ports/endpoint-repository.ts`, `src/modules/integrations/infra/sql/sql-endpoint.repository.ts`, `src/modules/integrations/application/endpoint.service.ts`, `src/modules/integrations/http/schemas.ts`, `src/modules/integrations/http/webhook-endpoints.controller.ts`, `test/unit/modules/integrations/schemas.spec.ts`, `openapi.json`
- Create: `test/e2e/integrations/endpoints-update.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 8; `assertIfMatch`, `mergePatchSchema` (`core/http`); `transitionEndpoint` (Task 4); `EndpointUpdatedEvent`, `EndpointEnabledEvent`, `EndpointDisabledEvent`, `EndpointDeletedEvent`, `EndpointSecretRotatedEvent` (Task 5); `Webhook` (test, `standardwebhooks`); `StandardWebhooksSigner` (test).
- Produces:
  - `EndpointRepository.update(id, next: { url: string; description: string | null; status: EndpointStatus; disabledReason: DisabledReason | null; clearFailing: boolean }): Promise<EndpointRow>` (bump version), `.softDelete(id, purgeDelaySec): Promise<void>`, `.rotateSecrets(endpointId, overlapSec): Promise<{ previousExpiresAt: Date | null }>`, `.signingSecrets(endpointId): Promise<{ publicId: string; secretEnc: string }[]>` (còn hạn, hiện hành trước).
  - `EndpointService.update(publicId, ifMatch, patch)`, `.remove(publicId, ifMatch)`, `.rotateSecret(publicId): Promise<{ secret: string; previousExpiresAt: Date | null }>`.
  - HTTP: `PatchEndpointBody` (`description`, `status`; strict: `url`/`eventTypes` → 422 `validation_failed`), `PatchEndpointDestinationBody` (`url`, `eventTypes`), `RotatedSecretResponse`; route `PATCH …/:endpointId` (200 + ETag, quyền thường), `PATCH …/:endpointId/destination` (200 + ETag, `@SessionOnly()` + `@RequireFreshSession()` + `@RequireVerifiedEmail()`, R-X34), `DELETE …/:endpointId` (204), `POST …/:endpointId/rotate-secret` (200).
  - **Vì sao tách route thay vì kiểm trong service (R-X34):** ba yêu cầu này là metadata route mà `AuthGuard` toàn cục đọc (`auth.guard.ts`: `SESSION_ONLY`, `REQUIRE_FRESH_SESSION`, `REQUIRE_VERIFIED_EMAIL`); identity không có API theo request để service tự hỏi "session có mới không" (`AuthFacts` chỉ có `requireFreshStaffAccess` của nhân viên). Kiểm trong service đòi thêm API vào identity (ngoài phạm vi 6C) hoặc chép luật `isFresh` (hai nguồn sự thật). Tách route dùng đúng decorator đã có, và đổi đích là thao tác cùng mức nguy hiểm với tạo endpoint (R-X34: đổi đích = tạo mới), nên có cùng bộ guard với `POST`.

- [ ] **Step 1: Test e2e (fail)**

`test/e2e/integrations/endpoints-update.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCipher } from '../../../src/core/security/index.js';
import { WebhookSecrets } from '../../../src/modules/integrations/application/webhook-secrets.js';
import { StandardWebhooksSigner } from '../../../src/modules/integrations/infra/standard-webhooks.signer.js';
import request from 'supertest';
import { TEST_ORIGIN } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import { endpointsUrl, fixedResolver, startIntegrationsApp } from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const OVERLAP_SEC = 3600;
const STALE_SEC = 86_400;

describe('update, delete and rotate a webhook endpoint (spec SP6 §8.3, §7.3, §7.4)', () => {
  let app: INestApplication;
  let owner: SeededPrincipal;
  let stale: SeededPrincipal;
  let unverified: SeededPrincipal;
  let org: SeededOrg;
  const create = async () => {
    const res = await authed(app, owner).post(endpointsUrl(org.orgId)).send({ url: 'https://hooks.example.test/x', eventTypes: ['tenancy.org.updated'] });
    expect(res.status).toBe(201);
    return { id: String(res.body.id), secret: String(res.body.secret) };
  };
  const one = (id: string) => `${endpointsUrl(org.orgId)}/${id}`;
  const destination = (id: string) => `${one(id)}/destination`;
  const eventsOf = (id: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM outbox_events WHERE org_id = $1 AND payload->>'endpointId' = $2 ORDER BY id`,
      [org.orgId, id],
    );
  /** Secret còn ký, giải mã bằng chính `WebhookSecrets` của app (thứ tự: hiện hành trước). */
  const signing = async (id: string) => {
    const rows = await orgQuery<{ public_id: string; secret_enc: string }>(
      org.orgId,
      `SELECT s.public_id::text, s.secret_enc FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.org_id = s.org_id AND e.id = s.endpoint_id
       WHERE e.public_id = $1 AND (s.expires_at IS NULL OR s.expires_at > now()) ORDER BY s.expires_at IS NULL DESC, s.created_at DESC`,
      [id],
    );
    const secrets = app.get(WebhookSecrets);
    return rows.map((r) => secrets.open(r.secret_enc, { orgId: org.orgId, secretPublicId: r.public_id }));
  };
  beforeAll(async () => {
    app = await startIntegrationsApp({
      // Cho phép principal chưa xác thực email có session (mẫu K-15 của 3D), để thấy riêng 403 email_not_verified của route.
      env: { INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC: String(OVERLAP_SEC), AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
      resolver: fixedResolver({ 'private.example.test': ['10.0.0.7'] }),
    });
    owner = await seedUserPrincipal();
    stale = await seedUserPrincipal({ sessionAgeSec: STALE_SEC });
    unverified = await seedUserPrincipal({ emailVerified: false });
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'ADMIN', { authUserId: stale.authUserId });
    await seedMember(org, 'ADMIN', { authUserId: unverified.authUserId });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals([owner, stale, unverified]);
  });

  it('PATCH needs If-Match (428), a stale one is 412; url/eventTypes on the plain route are 422; /destination changes url and event types, the plain route the description; one updated event each, host only', async () => {
    const e = await create();
    expect((await authed(app, owner).patch(one(e.id)).send({ description: 'x' })).status).toBe(428);
    expect((await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"9"').send({ description: 'x' })).status).toBe(412);
    const wrongRoute = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"1"').send({ url: 'https://other.example.test/y' });
    expect([wrongRoute.status, wrongRoute.body.code]).toEqual([422, 'validation_failed']);
    const dest = await authed(app, owner)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({ url: 'https://other.example.test/y?k=v', eventTypes: ['tenancy.org.updated', 'tenancy.member.added'] });
    expect(dest.status).toBe(200);
    expect(dest.headers.etag).toBe('W/"2"');
    expect(dest.body).toMatchObject({ url: 'https://other.example.test/y?k=v', eventTypes: ['tenancy.member.added', 'tenancy.org.updated'] });
    const desc = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"2"').send({ description: 'Ops' });
    expect([desc.status, desc.headers.etag, desc.body.description]).toEqual([200, 'W/"3"', 'Ops']);
    expect((await eventsOf(e.id)).filter((x) => x.type === 'integrations.endpoint.updated').map((x) => x.payload)).toEqual([
      { endpointId: e.id, changed: ['url', 'eventTypes'], urlHost: 'other.example.test', eventTypes: ['tenancy.member.added', 'tenancy.org.updated'] },
      { endpointId: e.id, changed: ['description'] },
    ]);
  });
  it('/destination to a private URL is 422 webhook_url_not_allowed and changes nothing; the same types in another order are a no-op (M3); description null clears it', async () => {
    const e = await create();
    const bad = await authed(app, owner).patch(destination(e.id)).set('if-match', 'W/"1"').send({ url: 'https://private.example.test/x' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('webhook_url_not_allowed');
    const noop = await authed(app, owner)
      .patch(destination(e.id))
      .set('if-match', 'W/"1"')
      .send({ url: 'https://hooks.example.test/x', eventTypes: ['tenancy.org.updated', 'tenancy.org.updated'] });
    expect(noop.status).toBe(200);
    expect(noop.headers.etag).toBe('W/"1"');
    const cleared = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"1"').send({ description: null });
    expect(cleared.body.description).toBeNull();
  });
  it('R-X34: /destination needs a fresh session — a stale ADMIN gets 403 reauthentication_required there, while the plain PATCH works', async () => {
    const e = await create();
    const refused = await authed(app, stale).patch(destination(e.id)).set('if-match', 'W/"1"').send({ url: 'https://evil.example.test/x' });
    expect([refused.status, refused.body.code]).toEqual([403, 'reauthentication_required']);
    const plain = await authed(app, stale).patch(one(e.id)).set('if-match', 'W/"1"').send({ description: 'still fine' });
    expect(plain.status).toBe(200);
    expect((await authed(app, owner).get(one(e.id))).body.url).toBe('https://hooks.example.test/x');
  });
  it('R-X34: /destination needs a verified email — an unverified ADMIN gets 403 email_not_verified there, while the plain PATCH works', async () => {
    const e = await create();
    const refused = await authed(app, unverified).patch(destination(e.id)).set('if-match', 'W/"1"').send({ eventTypes: ['tenancy.member.added'] });
    expect([refused.status, refused.body.code]).toEqual([403, 'email_not_verified']);
    expect((await authed(app, unverified).patch(one(e.id)).set('if-match', 'W/"1"').send({ status: 'DISABLED' })).status).toBe(200);
  });
  it('R-X34: /destination is session-only — the ADMIN user API key gets 403 forbidden', async () => {
    const e = await create();
    const created = await request(app.getHttpServer())
      .post('/api/auth/api-key/create')
      .set('authorization', `Bearer ${owner.bearer}`)
      .set('origin', TEST_ORIGIN)
      .send({ name: 'r-x34' });
    expect(created.status).toBe(200);
    const refused = await request(app.getHttpServer())
      .patch(destination(e.id))
      .set('x-api-key', String(created.body.key))
      .set('origin', TEST_ORIGIN)
      .set('if-match', 'W/"1"')
      .send({ url: 'https://evil.example.test/x' });
    expect([refused.status, refused.body.code]).toEqual([403, 'forbidden']);
  });
  it('disable → DISABLED(MANUAL) + disabled event; enable → ACTIVE, failing_since cleared + enabled event; repeating a status is a no-op', async () => {
    const e = await create();
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE public_id = $1`, [e.id]);
    const off = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"1"').send({ status: 'DISABLED' });
    expect(off.body).toMatchObject({ status: 'DISABLED', disabledReason: 'MANUAL' });
    const again = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"2"').send({ status: 'DISABLED' });
    expect(again.headers.etag).toBe('W/"2"');
    const on = await authed(app, owner).patch(one(e.id)).set('if-match', 'W/"2"').send({ status: 'ACTIVE' });
    expect(on.body).toMatchObject({ status: 'ACTIVE', disabledReason: null, failingSince: null });
    expect((await eventsOf(e.id)).map((x) => x.type)).toEqual([
      'integrations.endpoint.created',
      'integrations.endpoint.disabled',
      'integrations.endpoint.enabled',
    ]);
  });
  it('DELETE is a soft delete: 204, GET 404, purge_after = deleted_at + INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC, deleted event; a second DELETE is 404', async () => {
    const e = await create();
    expect((await authed(app, owner).delete(one(e.id))).status).toBe(204);
    expect((await authed(app, owner).get(one(e.id))).status).toBe(404);
    const [row] = await orgQuery<{ gap: number }>(
      org.orgId,
      `SELECT extract(epoch FROM purge_after - deleted_at)::int AS gap FROM webhook_endpoints WHERE public_id = $1`,
      [e.id],
    );
    expect(row?.gap).toBe(5_356_800);
    expect((await eventsOf(e.id)).map((x) => x.type)).toContain('integrations.endpoint.deleted');
    expect((await authed(app, owner).delete(one(e.id))).status).toBe(404);
  });
  it('rotate-secret: 200 { secret, previousExpiresAt = now + overlap }, no-store; both secrets sign and each verifies (W-2); secret_rotated event', async () => {
    const e = await create();
    const res = await authed(app, owner).post(`${one(e.id)}/rotate-secret`).send();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.secret).not.toBe(e.secret);
    const overlap = (Date.parse(res.body.previousExpiresAt) - Date.now()) / 1000;
    expect(overlap).toBeGreaterThan(OVERLAP_SEC - 60);
    expect(overlap).toBeLessThanOrEqual(OVERLAP_SEC);
    const live = await signing(e.id);
    expect(live).toEqual([res.body.secret, e.secret]);
    const at = new Date();
    const sig = new StandardWebhooksSigner().sign({ secrets: live, messageId: 'evt', timestamp: at, body: '{}' });
    const headers = { 'webhook-id': 'evt', 'webhook-timestamp': String(Math.floor(at.getTime() / 1000)), 'webhook-signature': sig };
    for (const s of [e.secret, res.body.secret]) expect(() => new Webhook(s).verify('{}', headers)).not.toThrow();
    expect((await eventsOf(e.id)).map((x) => x.type)).toContain('integrations.endpoint.secret_rotated');
  });
  it('Review Focus 4: rotating twice within the overlap keeps exactly two signing secrets; the first stops verifying and is deleted on the next rotation', async () => {
    const e = await create();
    const r1 = await authed(app, owner).post(`${one(e.id)}/rotate-secret`).send();
    const r2 = await authed(app, owner).post(`${one(e.id)}/rotate-secret`).send();
    const live = await signing(e.id);
    expect(live).toEqual([r2.body.secret, r1.body.secret]);
    const at = new Date();
    const sig = new StandardWebhooksSigner().sign({ secrets: live, messageId: 'evt', timestamp: at, body: '{}' });
    expect(sig.split(' ')).toHaveLength(2);
    const headers = { 'webhook-id': 'evt', 'webhook-timestamp': String(Math.floor(at.getTime() / 1000)), 'webhook-signature': sig };
    expect(() => new Webhook(e.secret).verify('{}', headers)).toThrow(/No matching signature/);
    await authed(app, owner).post(`${one(e.id)}/rotate-secret`).send();
    const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(
      org.orgId,
      `SELECT count(*)::int AS n FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [e.id],
    );
    expect(n).toBe(3); // r3 hiện hành, r2 còn hạn, r1 hết hạn ngay ở lần xoay thứ ba; secret gốc đã bị xoá ở lần thứ ba
  });
  it('the secret ciphertext is unreadable with a FieldCipher of another keyring (sanity of the AAD binding at rest)', async () => {
    const e = await create();
    const [row] = await orgQuery<{ public_id: string; secret_enc: string }>(
      org.orgId,
      `SELECT s.public_id::text, s.secret_enc FROM webhook_endpoint_secrets s JOIN webhook_endpoints e ON e.id = s.endpoint_id WHERE e.public_id = $1`,
      [e.id],
    );
    const foreign = new WebhookSecrets(new FieldCipher({ t1: Buffer.alloc(32, 7).toString('base64') }, 't1'));
    expect(() => foreign.open(row?.secret_enc ?? '', { orgId: org.orgId, secretPublicId: row?.public_id ?? '' })).toThrow();
  });
});
```
(Đếm `3` ở ca Review Focus 4: sau lần xoay thứ ba, bảng còn r3 (hiện hành), r2 (`expires_at = now + overlap`), r1 (`expires_at = now`, hết hạn, sẽ bị xoá ở lần xoay kế); secret gốc đã hết hạn từ lần thứ hai nên bị xoá ở lần thứ ba.)

Run: `pnpm vitest run --project integration test/e2e/integrations/endpoints-update.e2e.spec.ts`
Expected: FAIL (route chưa có).

- [ ] **Step 2: Repository**

`src/modules/integrations/ports/endpoint-repository.ts`: thêm vào lớp:
```ts
  /** Ghi đủ giá trị mới (service tính từ dòng đã khoá), `version + 1`. */
  abstract update(
    id: string,
    next: { url: string; description: string | null; status: EndpointStatus; disabledReason: DisabledReason | null; clearFailing: boolean },
  ): Promise<EndpointRow>;
  abstract softDelete(id: string, purgeDelaySec: number): Promise<void>;
  /** Xoá secret đã hết hạn; secret cũ còn hạn → hết hạn ngay; secret hiện hành → hết hạn sau `overlapSec`. */
  abstract rotateSecrets(endpointId: string, overlapSec: number): Promise<{ previousExpiresAt: Date | null }>;
  /** Secret còn ký (tối đa hai), hiện hành trước. */
  abstract signingSecrets(endpointId: string): Promise<{ publicId: string; secretEnc: string }[]>;
```
`src/modules/integrations/infra/sql/sql-endpoint.repository.ts`: thêm vào lớp (cùng file, cùng `ENDPOINT_COLUMNS`):
```ts
  async update(
    id: string,
    next: { url: string; description: string | null; status: EndpointStatus; disabledReason: DisabledReason | null; clearFailing: boolean },
  ): Promise<EndpointRow> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET url = ?, description = ?, status = ?, disabled_reason = ?,
         failing_since = CASE WHEN ?::boolean THEN NULL ELSE failing_since END, version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND deleted_at IS NULL`,
      [next.url, next.description, next.status, next.disabledReason, next.clearFailing, id],
    );
    const [r] = await this.db.execute(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.org_id = app_current_org() AND e.id = ?::bigint`, [id]);
    if (!r) throw new Error('webhook endpoint vanished after its update');
    return toEndpointRow(r);
  }
  async softDelete(id: string, purgeDelaySec: number): Promise<void> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET deleted_at = clock_timestamp(), purge_after = clock_timestamp() + make_interval(secs => ?::integer),
         version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND deleted_at IS NULL`,
      [purgeDelaySec, id],
    );
  }
  async rotateSecrets(endpointId: string, overlapSec: number): Promise<{ previousExpiresAt: Date | null }> {
    const scope = `org_id = app_current_org() AND endpoint_id = ?::bigint`;
    await this.db.execute(`DELETE FROM webhook_endpoint_secrets WHERE ${scope} AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()`, [endpointId]);
    // Thứ tự quan trọng: secret cũ còn hạn hết hạn TRƯỚC, rồi mới tới secret hiện hành (nếu ngược, câu sau sẽ chạm cả nó).
    await this.db.execute(
      `UPDATE webhook_endpoint_secrets SET expires_at = clock_timestamp(), updated_at = clock_timestamp() WHERE ${scope} AND expires_at > clock_timestamp()`,
      [endpointId],
    );
    const rows = z
      .array(z.object({ expires_at: z.coerce.date() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_endpoint_secrets SET expires_at = clock_timestamp() + make_interval(secs => ?::integer), updated_at = clock_timestamp()
           WHERE ${scope} AND expires_at IS NULL RETURNING expires_at`,
          [overlapSec, endpointId],
        ),
      );
    return { previousExpiresAt: rows[0]?.expires_at ?? null };
  }
  async signingSecrets(endpointId: string): Promise<{ publicId: string; secretEnc: string }[]> {
    return z
      .array(z.object({ public_id: z.uuid(), secret_enc: z.string() }))
      .parse(
        await this.db.execute(
          `SELECT public_id::text AS public_id, secret_enc FROM webhook_endpoint_secrets
           WHERE org_id = app_current_org() AND endpoint_id = ?::bigint AND (expires_at IS NULL OR expires_at > clock_timestamp())
           ORDER BY expires_at IS NULL DESC, created_at DESC`,
          [endpointId],
        ),
      )
      .map((r) => ({ publicId: r.public_id, secretEnc: r.secret_enc }));
  }
```
(Import `type DisabledReason, type EndpointStatus` từ `../../domain/webhook-endpoint.js`. `make_interval(secs => ?::integer)` nhận integer vì `secs` là `double precision` và Postgres ép ngầm int → double.)

- [ ] **Step 3: Service**

`src/modules/integrations/application/endpoint.service.ts`: thêm import `assertIfMatch` (`core/http`), `transitionEndpoint`, `type EndpointState`, `type EndpointStatus`, `type DisabledReason` (domain), `EndpointUpdatedEvent`, `EndpointEnabledEvent`, `EndpointDisabledEvent`, `EndpointDeletedEvent`, `EndpointSecretRotatedEvent`; thêm phương thức:
```ts
  async update(
    publicId: string,
    ifMatch: string | undefined,
    patch: { url?: string; description?: string | null; eventTypes?: readonly string[]; status?: EndpointStatus },
  ): Promise<EndpointRow> {
    const url = patch.url === undefined ? undefined : await this.checkedUrl(patch.url);
    const types = patch.eventTypes === undefined ? undefined : this.knownTypes(patch.eventTypes);
    return this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      assertIfMatch(ifMatch, cur.version, { required: true });
      const state: EndpointState = cur.status === 'ACTIVE' ? { status: 'ACTIVE' } : { status: 'DISABLED', reason: cur.disabledReason ?? 'MANUAL' };
      const move =
        patch.status === undefined ? { kind: 'UNCHANGED' as const } : transitionEndpoint(state, { kind: patch.status === 'ACTIVE' ? 'ENABLE' : 'DISABLE' });
      const nextUrl = url ?? cur.url;
      const nextDescription = patch.description === undefined ? cur.description : patch.description;
      const nextTypes = types ?? cur.eventTypes;
      // M3: cả hai phía đã sắp theo thứ tự byte (`knownTypes` và `COLLATE "C"`), nên so từng phần tử là so tập.
      const sameTypes = nextTypes.length === cur.eventTypes.length && nextTypes.every((t, i) => t === cur.eventTypes[i]);
      const changed = [
        ...(nextUrl !== cur.url ? (['url'] as const) : []),
        ...(nextDescription !== cur.description ? (['description'] as const) : []),
        ...(sameTypes ? [] : (['eventTypes'] as const)),
      ];
      // Không đổi gì → không tăng version, không event (mẫu Review Focus 2 của 3B).
      if (changed.length === 0 && move.kind === 'UNCHANGED') return cur;
      const next = move.kind === 'CHANGED' ? move.to : state;
      if (changed.includes('eventTypes')) await this.endpoints.setEventTypes(cur.id, nextTypes);
      const row = await this.endpoints.update(cur.id, {
        url: nextUrl,
        description: nextDescription,
        status: next.status,
        disabledReason: next.status === 'DISABLED' ? next.reason : null,
        clearFailing: move.kind === 'CHANGED' && next.status === 'ACTIVE',
      });
      const aggregate = { type: ENDPOINT_AGGREGATE, id: row.publicId, version: row.version };
      const actor = userActor(this.ctx);
      if (changed.length > 0)
        await this.events.publish(EndpointUpdatedEvent, {
          data: {
            endpointId: row.publicId,
            changed,
            ...(changed.includes('url') ? { urlHost: urlHost(row.url) } : {}),
            ...(changed.includes('eventTypes') ? { eventTypes: row.eventTypes } : {}),
          },
          aggregate,
          actor,
        });
      if (move.kind === 'CHANGED')
        await (move.to.status === 'ACTIVE'
          ? this.events.publish(EndpointEnabledEvent, { data: { endpointId: row.publicId }, aggregate, actor })
          : this.events.publish(EndpointDisabledEvent, { data: { endpointId: row.publicId, reason: move.to.reason }, aggregate, actor }));
      return row;
    });
  }

  /** Xoá mềm (spec §7.3): delivery còn chờ bị `CANCELLED` lúc claim; dòng bị sweep xoá cứng sau `PURGE_DELAY`. */
  async remove(publicId: string, ifMatch: string | undefined): Promise<void> {
    await this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      assertIfMatch(ifMatch, cur.version, { required: false });
      await this.endpoints.softDelete(cur.id, this.cfg.endpointPurgeDelaySec);
      await this.events.publish(EndpointDeletedEvent, {
        data: { endpointId: cur.publicId },
        aggregate: { type: ENDPOINT_AGGREGATE, id: cur.publicId, version: cur.version + 1 },
        actor: userActor(this.ctx),
      });
    });
  }

  /** Spec §8.3 "Xoay secret", §7.4: tối đa hai secret còn ký sau mỗi lần xoay (Review Focus 4). */
  async rotateSecret(publicId: string): Promise<{ secret: string; previousExpiresAt: Date | null }> {
    const orgId = this.orgId();
    const secret = this.secrets.generate();
    const secretPublicId = v7();
    return this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      const { previousExpiresAt } = await this.endpoints.rotateSecrets(cur.id, this.cfg.secretRotationOverlapSec);
      await this.endpoints.insertSecret({ endpointId: cur.id, publicId: secretPublicId, secretEnc: this.secrets.seal(secret, { orgId, secretPublicId }) });
      await this.events.publish(EndpointSecretRotatedEvent, {
        data: { endpointId: cur.publicId },
        aggregate: { type: ENDPOINT_AGGREGATE, id: cur.publicId, version: cur.version },
        actor: userActor(this.ctx),
      });
      return { secret, previousExpiresAt };
    });
  }
```
(`setEventTypes` chạy trước `update` để `update` đọc lại đúng tập mới trong cùng transaction.)

- [ ] **Step 4: HTTP**

`src/modules/integrations/http/schemas.ts`: thêm (import `mergePatchSchema` từ `core/http`):
```ts
/** Route thường (R-X34): không đổi đích. Strict (`mergePatchSchema` dựng `z.strictObject`): `url`/`eventTypes` ở đây → 422. */
export const PatchEndpointBody = mergePatchSchema(z.object({ description: description.nullable(), status: z.enum(ENDPOINT_STATUSES) }));
/** `PATCH …/destination` (R-X34): đổi nơi dữ liệu của org được gửi tới, cùng bộ guard với tạo endpoint. */
export const PatchEndpointDestinationBody = mergePatchSchema(z.object({ url, eventTypes }));
export const RotatedSecretResponse = z.object({ secret: z.string(), previousExpiresAt: iso.nullable() });
```
`src/modules/integrations/http/webhook-endpoints.controller.ts`: thêm import `Delete`, `Headers`, `HttpCode`, `HttpStatus`, `Patch` (`@nestjs/common`), `PatchEndpointBody`, `PatchEndpointDestinationBody`, `RotatedSecretResponse`; thêm route:
```ts
  /** Mô tả và trạng thái: quyền thường (session cũ, API key của user đều được). */
  @Patch(':endpointId')
  @WebhookPermissions.require('webhooks.write')
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(CoreErrors.VALIDATION_FAILED, CoreErrors.PRECONDITION_REQUIRED, CoreErrors.PRECONDITION_FAILED, CoreErrors.NOT_FOUND)
  async update(
    @Param('endpointId') endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchEndpointBody }) body: z.infer<typeof PatchEndpointBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const row = await this.endpoints.update(publicIdOrNotFound(endpointId), ifMatch, { description: body.description, status: body.status });
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  /** R-X34: đổi đích = tạo mới — session của người, mới, email đã xác thực (S6-A35), như `POST`. */
  @Patch(':endpointId/destination')
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(WebhookEndpointResponse)
  @ApiProblems(
    IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED,
    IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    CoreErrors.VALIDATION_FAILED,
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
    CoreErrors.NOT_FOUND,
  )
  async updateDestination(
    @Param('endpointId') endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchEndpointDestinationBody }) body: z.infer<typeof PatchEndpointDestinationBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const row = await this.endpoints.update(publicIdOrNotFound(endpointId), ifMatch, { url: body.url, eventTypes: body.eventTypes });
    res.setHeader('ETag', etagOf(row.version));
    return serialize(WebhookEndpointResponse, endpointOf(row));
  }

  @Delete(':endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WebhookPermissions.require('webhooks.write')
  @ApiProblems(CoreErrors.PRECONDITION_FAILED, CoreErrors.NOT_FOUND)
  async remove(@Param('endpointId') endpointId: string, @Headers('if-match') ifMatch: string | undefined): Promise<void> {
    await this.endpoints.remove(publicIdOrNotFound(endpointId), ifMatch);
  }

  /** Không `@Idempotent()` (trả secret). Session mới như lúc tạo (S6-A35). */
  @Post(':endpointId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @ApiOk(RotatedSecretResponse)
  @ApiProblems(IdentityErrors.REAUTHENTICATION_REQUIRED, CoreErrors.NOT_FOUND)
  async rotateSecret(@Param('endpointId') endpointId: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const r = await this.endpoints.rotateSecret(publicIdOrNotFound(endpointId));
    res.setHeader('Cache-Control', 'no-store');
    return serialize(RotatedSecretResponse, { secret: r.secret, previousExpiresAt: r.previousExpiresAt?.toISOString() ?? null });
  }
```
(Kiểu của `body` sau `mergePatchSchema` là `MergePatch<…>`: `description` có `null`, các trường khác không; hai route ánh xạ tường minh sang tham số `patch` của service, nên mỗi route chỉ chạm đúng trường của nó. `EndpointService.update` giữ một thân cho cả hai: khoá, `If-Match`, tính `changed`, event — không có luật nào bị chép hai nơi.)

`test/unit/modules/integrations/schemas.spec.ts`: import thêm `PatchEndpointDestinationBody` và đổi mảng của ca M7 thành `[CreateEndpointBody, PatchEndpointDestinationBody]`.

- [ ] **Step 5: Chạy, sinh lại OpenAPI**

Run:
```bash
pnpm vitest run --project integration test/e2e/integrations
pnpm typecheck && pnpm arch
pnpm build && pnpm openapi:export && git diff --stat openapi.json
```
Expected: PASS (Task 8 + Task 9); `openapi.json` thêm `PATCH …/:endpointId`, `PATCH …/:endpointId/destination`, `DELETE`, `rotate-secret`.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/e2e/integrations
git add src/modules/integrations test/e2e/integrations/endpoints-update.e2e.spec.ts test/unit/modules/integrations/schemas.spec.ts openapi.json
git commit -m "feat(integrations): update with If-Match and merge-patch, destination changes behind a fresh verified session, soft delete, secret rotation with overlap; audited endpoint events"
```

---

## Phần E — Fan-out, gửi, sức khoẻ endpoint, sweep (spec §8.3 "Fan-out", "Gửi", "Sweep", §7.2, §7.3, §10)

### Task 10: Fan-out từ bộ chọn `WEBHOOK_EVENTS` (W-40 phần DB, R6-15), repository delivery, bản cài `WebhookStatsReader` (R-X16)

**Files:**
- Create: `src/modules/integrations/ports/delivery-repository.ts`, `src/modules/integrations/infra/sql/created-at-key.ts`, `src/modules/integrations/infra/sql/sql-delivery.repository.ts`, `src/modules/integrations/application/fanout.subscriber.ts`, `src/modules/integrations/application/webhook-stats.reader.ts`, `test/integration/integrations/fanout.spec.ts`
- Modify: `src/modules/integrations/ports/endpoint-repository.ts`, `src/modules/integrations/infra/sql/sql-endpoint.repository.ts`, `src/modules/integrations/integrations.module.ts`

**Interfaces:**
- Consumes: `EventSubscriber`, `WEBHOOK_EVENTS`, `type EventEnvelope` (`core/events`); `Inbox`, `SafeEnqueue` (`core/outbox`); `OrgScope`, `UnitOfWork` (`core/database`); `WebhookStatsReader` (`core/contracts/admin-readers.ts`); `buildWebhookBody` (Task 4); `DeliverWebhookJob`, `deliveryJobId` (Task 5); `integrationsSpan` (Task 6); `EndpointRepository` (Task 8); test: `integrationsCoreImports` (Task 8), `createTestApp`, `seedOrg`, `inOrg`, `insertEndpoint`, `orgQuery`, `ownerQuery`.
- Produces:
  - `CREATED_AT_KEY_SQL(alias)` (`infra/sql/created-at-key.ts`): biểu thức SQL ra chuỗi ISO micro giây UTC của `created_at`.
  - `type DeliveryRef = { id: string; publicId: string; createdAt: string }`; `type ClaimedDelivery = DeliveryRef & { endpointId: string; messageId: string; attemptsTotal: number; cycleBase: number; localFailures: number; createdAtMs: number }`; `type DeliveryResult = { kind: 'SUCCEEDED'; statusCode: number } | { kind: 'RETRY'; statusCode: number | null; error: AttemptError; delayMs: number; cycleBump: 0 | 1; localBump: 0 | 1 } | { kind: 'EXHAUSTED'; statusCode: number | null; error: AttemptError; localBump: 0 | 1 }`.
  - `abstract class DeliveryRepository` với `insertMessage(m): Promise<{ id: string; createdAt: string }>`, `insertDeliveries(message, endpointIds): Promise<string[]>` (public id theo thứ tự `endpointIds`). Task 11, 13, 14 thêm phương thức.
  - `EndpointRepository.activeSubscribers(eventType): Promise<string[]>` (id nội bộ của endpoint `ACTIVE`, chưa xoá, có đăng ký `eventType`, tăng dần; khoá `FOR KEY SHARE OF e` tới hết transaction fan-out — R-X33: người ghi delivery giữ dòng cha, nên sweep xoá cứng (`FOR UPDATE`) không chen được).
  - `WebhookFanoutSubscriber` (consumer `integrations.webhook-fanout`, bộ chọn `WEBHOOK_EVENTS`, chỉ worker), `SqlWebhookStatsReader extends WebhookStatsReader` (chỉ api, qua `IntegrationsReadersModule`).

- [ ] **Step 1: Test (fail)**

`test/integration/integrations/fanout.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookStatsReader } from '../../../src/core/contracts/admin-readers.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import type { EventEnvelope } from '../../../src/core/events/index.js';
import { Inbox } from '../../../src/core/outbox/index.js';
import { WebhookFanoutSubscriber } from '../../../src/modules/integrations/application/fanout.subscriber.js';
import { IntegrationsReadersModule } from '../../../src/modules/integrations/integrations.module.js';
import { EndpointRepository } from '../../../src/modules/integrations/ports/endpoint-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import { inOrg, insertEndpoint, orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const CONSUMER = 'integrations.webhook-fanout';
const updated = (orgId: string | null, data: unknown = { orgId, changed: ['name'] }): EventEnvelope<unknown> => ({
  id: v7(),
  type: 'tenancy.org.updated',
  version: 1,
  occurredAt: '2026-10-07T01:02:03.456Z',
  orgId,
  actor: { type: 'user', id: v7() },
  aggregate: { type: 'organization', id: orgId ?? v7(), version: 2 },
  correlationId: 'test',
  causationId: null,
  data,
});

describe('webhook fan-out (spec SP6 §8.3 "Fan-out", W-40, R6-15)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let active: { id: string; publicId: string };
  const deliver = (e: EventEnvelope<unknown>) =>
    app.get(OrgScope).run(org.orgId, () =>
      app.get(UnitOfWork).run(() => app.get(Inbox).once(CONSUMER, e.id, () => app.get(WebhookFanoutSubscriber).handle(e))),
    );
  beforeAll(async () => {
    // Worker (subscriber) + module reader của api; không nạp `forApi()` (controller cần `HttpModule`, test này không có HTTP).
    app = await createTestApp(integrationsCoreImports([IntegrationsReadersModule]));
    org = await seedOrg();
    await inOrg(org.orgId, async (c) => {
      active = await insertEndpoint(c, org.orgId, { eventTypes: ['tenancy.org.updated'] });
      await insertEndpoint(c, org.orgId, { eventTypes: ['tenancy.org.updated'], status: 'DISABLED' });
      await insertEndpoint(c, org.orgId, { eventTypes: ['tenancy.member.added'] });
      const deleted = await insertEndpoint(c, org.orgId, { eventTypes: ['tenancy.org.updated'] });
      await c.query(`UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [deleted.id]);
    });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('one message serialised once, one PENDING delivery per ACTIVE subscribed endpoint, and its first job (webhook-<id>-a1) via the outbox', async () => {
    const e = updated(org.orgId);
    expect(await deliver(e)).toBe('processed');
    const messages = await orgQuery<{ id: string; event_type: string; body: string }>(
      org.orgId,
      `SELECT id::text, event_type, body FROM webhook_messages WHERE event_id = $1`,
      [e.id],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe(
      `{"type":"tenancy.org.updated","version":1,"timestamp":"2026-10-07T01:02:03.456Z","data":{"orgId":"${org.orgId}","changed":["name"]}}`,
    );
    const deliveries = await orgQuery<{ public_id: string; endpoint_id: string; status: string; attempts_total: number }>(
      org.orgId,
      `SELECT public_id::text, endpoint_id::text, status, attempts_total FROM webhook_deliveries WHERE message_id = $1`,
      [messages[0]?.id],
    );
    expect(deliveries).toEqual([{ public_id: expect.any(String), endpoint_id: active.id, status: 'PENDING', attempts_total: 0 }]);
    const jobs = await ownerQuery<{ payload: { job: string; jobId: string; payload: { deliveryId: string } } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2`,
      [org.orgId, deliveries[0]?.public_id],
    );
    expect(jobs.map((j) => j.payload.jobId)).toEqual([`webhook-${deliveries[0]?.public_id}-a1`]);
    expect(jobs[0]?.payload.job).toBe('integrations.deliver-webhook');
  });
  it('R6-15: delivering the same event twice is a no-op the second time (inbox of integrations.webhook-fanout)', async () => {
    const e = updated(org.orgId);
    expect(await deliver(e)).toBe('processed');
    expect(await deliver(e)).toBe('duplicate');
    expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_messages WHERE event_id = $1`, [e.id])).toHaveLength(1);
  });
  it('an event nobody subscribed to writes nothing', async () => {
    const e = { ...updated(org.orgId), type: 'tenancy.org.restored', data: { orgId: org.orgId } };
    await deliver(e);
    expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_messages WHERE event_id = $1`, [e.id])).toEqual([]);
  });
  it('a body over WEBHOOK_BODY_MAX_BYTES is skipped (design error, logged), nothing written', async () => {
    const e = updated(org.orgId, { orgId: org.orgId, changed: ['name'], pad: 'x'.repeat(262_144) });
    await deliver(e);
    expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_messages WHERE event_id = $1`, [e.id])).toEqual([]);
  });
  it('WebhookStatsReader counts the live endpoints of the org in scope (deleted ones do not count)', async () => {
    const n = await app.get(OrgScope).run(org.orgId, () => app.get(WebhookStatsReader).endpointCount());
    expect(n).toBe(3);
  });
  it('R-X33: the fan-out holds FOR KEY SHARE on the endpoints it picked until commit — FOR UPDATE (hard delete) waits, FOR NO KEY UPDATE (claim, PATCH) does not', async () => {
    const probe = (lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE') =>
      inOrg(org.orgId, (c) => c.query(`SELECT 1 FROM webhook_endpoints WHERE id = $1 ${lock} NOWAIT`, [active.id])).then(
        () => 'free',
        (err: unknown) => (err instanceof Error && 'code' in err ? String(err.code) : 'unknown'),
      );
    const seen = await app.get(OrgScope).run(org.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        expect(await app.get(EndpointRepository).activeSubscribers('tenancy.org.updated')).toEqual([active.id]);
        return { update: await probe('FOR UPDATE'), noKeyUpdate: await probe('FOR NO KEY UPDATE') };
      }),
    );
    expect(seen).toEqual({ update: '55P03', noKeyUpdate: 'free' });
    expect(await probe('FOR UPDATE')).toBe('free');
  });
});
```
(Ca "body quá lớn" gọi `handle` thẳng với `data` có thêm khoá `pad`: subscriber nhận envelope đã parse, nên test dựng được dữ liệu vượt trần mà không qua schema; trên đường thật, deliver parse theo schema trước. Ca R-X33 dùng `NOWAIT` (`55P03` = lock_not_available) để thấy khoá mà không chờ: tất định, không cần barrier.)

Run: `pnpm vitest run --project integration test/integration/integrations/fanout.spec.ts`
Expected: FAIL (`WebhookFanoutSubscriber` chưa có).

- [ ] **Step 2: Repository delivery (phần fan-out)**

`src/modules/integrations/infra/sql/created-at-key.ts`:
```ts
/**
 * `created_at` của message/delivery là một phần của khoá (partition + FK). App mang nó dưới dạng chuỗi ISO micro giây UTC,
 * không qua `Date` (mili giây): `created_at = ?::timestamptz` với giá trị mất micro giây sẽ không khớp dòng nào.
 */
export const CREATED_AT_KEY_SQL = (alias: string): string =>
  `to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Cùng định dạng, cho zod (cursor, test). */
export const CREATED_AT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
```
`src/modules/integrations/ports/delivery-repository.ts`:
```ts
import type { AttemptError } from '../domain/webhook-delivery.js';

/** `id` BIGINT nội bộ (text); `createdAt` là chuỗi ISO micro giây (`CREATED_AT_KEY_SQL`): cùng tạo thành khoá dòng. */
export type DeliveryRef = { id: string; publicId: string; createdAt: string };
export type ClaimedDelivery = DeliveryRef & {
  endpointId: string;
  messageId: string;
  attemptsTotal: number;
  cycleBase: number;
  /** `local_failures` lúc claim (R-X35), trước lần thử này. */
  localFailures: number;
  createdAtMs: number;
};
/** `localBump: 1` ở mọi lỗi của ta (R-X35), `0` ở lỗi của endpoint. */
export type DeliveryResult =
  | { kind: 'SUCCEEDED'; statusCode: number }
  | { kind: 'RETRY'; statusCode: number | null; error: AttemptError; delayMs: number; cycleBump: 0 | 1; localBump: 0 | 1 }
  | { kind: 'EXHAUSTED'; statusCode: number | null; error: AttemptError; localBump: 0 | 1 };

/** Mọi phương thức chạy trong OrgScope + `UnitOfWork.run` của caller. */
export abstract class DeliveryRepository {
  abstract insertMessage(m: { eventId: string; eventType: string; eventVersion: number; body: string }): Promise<{ id: string; createdAt: string }>;
  /** Một delivery `PENDING` mỗi endpoint, cùng `created_at` với message; trả public id theo thứ tự `endpointIds`. */
  abstract insertDeliveries(message: { id: string; createdAt: string }, endpointIds: readonly string[]): Promise<string[]>;
}
```
`src/modules/integrations/infra/sql/sql-delivery.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { DeliveryRepository } from '../../ports/delivery-repository.js';
import { CREATED_AT_KEY_SQL } from './created-at-key.js';

const MessageRow = z.array(z.object({ id: z.string(), created_at: z.string() }));

@Injectable()
export class SqlDeliveryRepository extends DeliveryRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insertMessage(m: { eventId: string; eventType: string; eventVersion: number; body: string }): Promise<{ id: string; createdAt: string }> {
    const [r] = MessageRow.parse(
      await this.db.execute(
        `INSERT INTO webhook_messages AS m (org_id, event_id, event_type, event_version, body) VALUES (app_current_org(), ?::uuid, ?, ?::integer, ?)
         RETURNING m.id::text AS id, ${CREATED_AT_KEY_SQL('m')} AS created_at`,
        [m.eventId, m.eventType, m.eventVersion, m.body],
      ),
    );
    if (!r) throw new Error('webhook message insert returned no row');
    return { id: r.id, createdAt: r.created_at };
  }

  async insertDeliveries(message: { id: string; createdAt: string }, endpointIds: readonly string[]): Promise<string[]> {
    if (endpointIds.length === 0) return [];
    const publicIds = endpointIds.map(() => v7());
    await this.db.execute(
      `INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
       SELECT x.p, app_current_org(), x.e, ?::bigint, ?::timestamptz, 'PENDING', clock_timestamp()
       FROM unnest(ARRAY[?]::uuid[], ARRAY[?]::bigint[]) AS x(p, e)`,
      [message.id, message.createdAt, publicIds, endpointIds],
    );
    return publicIds;
  }
}
```
`src/modules/integrations/ports/endpoint-repository.ts`: thêm
```ts
  /**
   * Id nội bộ của endpoint `ACTIVE`, chưa xoá, có đăng ký `eventType`, tăng dần (fan-out). Khoá `FOR KEY SHARE` tới hết
   * transaction của caller (R-X33): không FK delivery → endpoint, nên người ghi delivery tự giữ dòng cha.
   */
  abstract activeSubscribers(eventType: string): Promise<string[]>;
```
`src/modules/integrations/infra/sql/sql-endpoint.repository.ts`: thêm
```ts
  async activeSubscribers(eventType: string): Promise<string[]> {
    return z
      .array(z.object({ id: z.string() }))
      .parse(
        await this.db.execute(
          `SELECT e.id::text AS id FROM webhook_endpoint_event_types t
           JOIN webhook_endpoints e ON e.org_id = t.org_id AND e.id = t.endpoint_id
           WHERE t.org_id = app_current_org() AND t.event_type = ? AND e.status = 'ACTIVE' AND e.deleted_at IS NULL
           ORDER BY e.id FOR KEY SHARE OF e`,
          [eventType],
        ),
      )
      .map((r) => r.id);
  }
```

- [ ] **Step 3: Subscriber và reader**

`src/modules/integrations/application/fanout.subscriber.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { EventSubscriber, WEBHOOK_EVENTS, type EventEnvelope } from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { buildWebhookBody } from '../domain/webhook-payload.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';

/**
 * Spec SP6 §8.3 "Fan-out": chạy trong `UnitOfWork` + `Inbox.once` của `DeliverEventHandler` (R6-15) và OrgScope của event.
 * Chỉ DB + `SafeEnqueue` (ghi outbox, gửi sau commit): không I/O ngoài trong transaction.
 */
@Injectable()
@EventSubscriber({ consumer: 'integrations.webhook-fanout', events: WEBHOOK_EVENTS })
export class WebhookFanoutSubscriber {
  private readonly logger = new Logger(WebhookFanoutSubscriber.name);
  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly enqueue: SafeEnqueue,
  ) {}

  async handle(e: EventEnvelope<unknown>): Promise<void> {
    await integrationsSpan('integrations.fanout', () => this.fanOut(e), (n) => ({ 'webhook.deliveries': n }));
  }

  private async fanOut(e: EventEnvelope<unknown>): Promise<number> {
    // `EventPublisher` đã từ chối phát event `webhook: true` ngoài org; tới đây là dòng outbox lạ: bỏ qua, có log.
    if (e.orgId === null) {
      this.logger.warn({ event: 'webhook_event_without_org', type: e.type }, 'webhook event without an organization skipped');
      return 0;
    }
    const endpointIds = await this.endpoints.activeSubscribers(e.type);
    if (endpointIds.length === 0) return 0;
    const built = buildWebhookBody({ type: e.type, version: e.version, timestamp: e.occurredAt, data: e.data });
    if (built.kind === 'TOO_LARGE') {
      this.logger.error({ event: 'webhook_body_too_large', eventType: e.type, bytes: built.bytes }, 'webhook body exceeds the format limit; not sent');
      return 0;
    }
    const message = await this.deliveries.insertMessage({ eventId: e.id, eventType: e.type, eventVersion: e.version, body: built.body });
    const ids = await this.deliveries.insertDeliveries(message, endpointIds);
    for (const deliveryId of ids) await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId }, { jobId: deliveryJobId(deliveryId, 1) });
    return ids.length;
  }
}
```
`src/modules/integrations/application/webhook-stats.reader.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { WebhookStatsReader } from '../../../core/contracts/admin-readers.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';

/** Bản cài token của `core/contracts` (R-X16, S6-A52): admin inject `@Optional()`, không import `integrations/index.ts`. */
@Injectable()
export class SqlWebhookStatsReader extends WebhookStatsReader {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly endpoints: EndpointRepository,
  ) {
    super();
  }
  endpointCount(): Promise<number> {
    return this.uow.run(() => this.endpoints.countLive());
  }
}
```
`src/modules/integrations/integrations.module.ts`:
- `IntegrationsCoreModule.providers` thêm `SqlDeliveryRepository`, `{ provide: DeliveryRepository, useExisting: SqlDeliveryRepository }`; `exports` thêm `DeliveryRepository`.
- `IntegrationsReadersModule`: `providers: [SqlWebhookStatsReader, { provide: WebhookStatsReader, useExisting: SqlWebhookStatsReader }]`, `exports: [WebhookStatsReader]`.
- `IntegrationsWorkerModule.providers` thêm `WebhookFanoutSubscriber`.

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project integration test/integration/integrations/fanout.spec.ts test/integration/core/events
pnpm typecheck && pnpm arch
```
Expected: PASS; `pnpm arch` không còn cảnh báo `no-orphans` cho `src/core/contracts/admin-readers.ts` (đã có người import; ngoại lệ đã bỏ ở Task 6).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/integration/integrations/fanout.spec.ts
git add src/modules/integrations test/integration/integrations/fanout.spec.ts
git commit -m "feat(integrations): fan-out of webhook events to active subscribed endpoints through the inbox; WebhookStatsReader for admin"
```

---

### Task 11: Gửi — claim có lease và bulkhead in-flight theo endpoint, ký nhiều secret, `HttpClient('webhooks-out')`, phân loại kết quả, CAS có fencing, lịch retry, trần lỗi của ta, hết lịch, kill switch, provider `webhooks-out`; sweep (job mất, lease hết hạn, xoá cứng endpoint) (W-1…W-4, W-10, W-11, W-14, W-15, W-20…W-24, W-33 phần claim, W-34, W-40, W-45, R6-10, R6-25, R6C-3, R6C-4, R-X33, R-X35)

**Vì sao sweep nằm ở task này (review I2):** `webhook-flow.e2e.spec.ts` chạy app với `consumeWebhooks: true`, tức worker consume queue `webhooks-out`; `WorkerHost.assertHandlersFor` (`src/core/queue/worker-host.ts:107-116`) từ chối khởi động khi một job của queue được consume (ở đây `integrations.sweep-org`) chưa có `@JobHandler`. Vì vậy cả hai handler sweep phải có cùng task với handler gửi; test luồng thật không bị dời ra sau.

**Files:**
- Create: `src/modules/integrations/application/deliver-webhook.handler.ts`, `src/modules/integrations/application/local-failures.ts`, `src/modules/integrations/application/sweep.handlers.ts`, `src/modules/integrations/application/webhooks-out-policy.ts`, `test/support/webhook-receiver.ts`, `test/support/integrations-delivery.ts`, `test/e2e/integrations/deliver.e2e.spec.ts`, `test/e2e/integrations/deliver-ssrf.e2e.spec.ts`, `test/e2e/integrations/deliver-local-faults.e2e.spec.ts`, `test/e2e/integrations/deliver-inflight.e2e.spec.ts`, `test/e2e/integrations/webhook-flow.e2e.spec.ts`, `test/integration/integrations/sweep.spec.ts`
- Modify: `src/modules/integrations/ports/delivery-repository.ts`, `src/modules/integrations/infra/sql/sql-delivery.repository.ts`, `src/modules/integrations/ports/endpoint-repository.ts`, `src/modules/integrations/infra/sql/sql-endpoint.repository.ts`, `src/modules/integrations/integrations.module.ts`

**Interfaces:**
- Consumes: `HttpClient`, `ResiliencePolicies.setProviderDefaults(provider, Partial<PolicyConfig>)` (`core/resilience`); `KillSwitches.isKilled(key)`, `KillSwitches.set(change)`, `DbKillSwitchProvider.refreshOnce()`, `NO_ROW_VERSION` (`core/flags`); `JobHandler`, `type JobContext` (`core/queue`); `SafeEnqueue`; `EventPublisher`; `appConfig` (`core/config`); `classifyAttempt`, `scheduledDelaySec`, `jitteredMs`, `retryDelayMs`, `outcomeOfStatus`, `outcomeOfError` (Task 4); `WebhookSecrets`, `WebhookSigner` (Task 7); `DeliverWebhookJob`, `deliveryJobId`, `killedJobId`, `busyJobId`, `sweptJobId`, `IntegrationsSweep`, `IntegrationsSweepOrgJob`, `WebhookDeliveryKillSwitch`, `DeliveryExhaustedEvent`, `EndpointDisabledEvent` (Task 5); `localRetryLeft` (Task 4); `FieldCipherError` (`core/security`); `OrgSweepRunner.run(def)`, `type OrgSweepResult` (`core/sweep`); `JobQueue` (`core/queue`, test); `IntegrationsMetrics`, `integrationsSpan` (Task 6); `DeliveryRepository`, `EndpointRepository` (Task 8, 10); `orphanDeliveries` (Task 3).
- Produces:
  - `DeliveryRepository.dueEndpointOf(publicId, skewMs): Promise<string | undefined>` (endpoint của delivery còn claim được và đã đến hạn; không khoá), `.claim(publicId, leaseMs, skewMs): Promise<ClaimedDelivery | undefined>`, `.cancelClaimed(ref, attempts): Promise<boolean>`, `.messageOf(ref & { messageId }): Promise<{ eventId: string; eventType: string; body: string }>`, `.describe(ref & { endpointId; messageId }): Promise<{ endpointPublicId: string; eventType: string; eventId: string }>` (cho event `exhausted` của nhánh lỗi của ta), `.finish(ref, attempts, result: DeliveryResult): Promise<boolean>` (`false` = bị fence), `.defer(publicId, delayMs, skewMs): Promise<number | undefined>` (sự kiện `DEFER`: kill switch hoặc endpoint đủ in-flight; `next_attempt_at = GREATEST(next_attempt_at, now + delay)` và chỉ khi đã đến hạn — M1; trả `attempts_total` khi đã dời), `.takeOverdue(graceSec, limit)`, `.expiredLeases(graceSec, limit)`.
  - `EndpointRepository.lockForClaim(endpointId): Promise<number | undefined>` (khoá `FOR NO KEY UPDATE`, rồi đếm `SENDING` còn lease bằng câu riêng — R-X35, R6C-4), `.forSend(endpointId): Promise<{ publicId: string; url: string; status: EndpointStatus; deleted: boolean } | undefined>`, `.clearFailing(endpointId): Promise<void>`, `.markFailing(endpointId): Promise<void>`, `.autoDisable(endpointId, afterSec): Promise<{ publicId: string; version: number } | undefined>`, `.purgeDue(limit, postponeSec)`.
  - `LocalFailures.record(claim, error, statusCode): Promise<'local_fault' | 'exhausted' | 'fenced'>` (`application/local-failures.ts`; một luật R-X35 cho ba nơi: lỗi của `HttpClient`, secret không giải mã được lúc claim, lease hết hạn ở sweep).
  - `DeliverWebhookHandler` (`@JobHandler(DeliverWebhookJob)`): `handle(ctx: JobContext<{ deliveryId: string }>): Promise<void>`; `type DeliverResult = 'killed' | 'busy' | 'skipped' | 'cancelled' | 'succeeded' | 'retry_scheduled' | 'exhausted' | 'local_fault' | 'fenced'`.
  - `IntegrationsSweepHandler` (`@JobHandler(IntegrationsSweep.job)`, gọi `OrgSweepRunner.run`), `IntegrationsSweepOrgHandler` (`@JobHandler(IntegrationsSweepOrgJob)`): `handle(): Promise<SweepOrgResult>`, `type SweepOrgResult = { requeued: number; leases: number; exhausted: number; purged: number; postponed: number }`.
  - `WebhooksOutPolicy` (`onModuleInit`: `setProviderDefaults('webhooks-out', { retries: 0, timeoutMs, breakerThreshold: WEBHOOK_BREAKER_NEVER, bulkheadLimit, bulkheadQueue })`).
  - `test/support/webhook-receiver.ts`: `startWebhookReceiver(): Promise<WebhookReceiver>`; `type WebhookReceiver = { port: number; url(path?: string): string; requests: ReceivedRequest[]; connections(): number; respondWith(...r: ReceiverResponse[]): void; hold(): void; release(): void; waitFor(n: number, timeoutMs?: number): Promise<ReceivedRequest[]>; close(): Promise<void> }`; `type ReceiverResponse = { status: number; headers?: Record<string, string>; body?: string; delayMs?: number }`.
  - `test/support/integrations-delivery.ts`: `receiverEnv(receiver)`, `jobCtx(deliveryId, orgId)`, `runDeliver(app, orgId, deliveryId)`, `seedPendingDelivery(orgId, o: { url; eventType?; body? }): Promise<{ deliveryId; endpoint; message; secret }>` (endpoint + secret thật mã hoá bằng `WebhookSecrets` của app), `deliveryRow(orgId, deliveryId)`, `makeDue(orgId, deliveryId)`.

- [ ] **Step 1: Hỗ trợ test**

`test/support/webhook-receiver.ts`:
```ts
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ReceivedRequest = { headers: IncomingHttpHeaders; body: string; at: number };
export type ReceiverResponse = { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
export type WebhookReceiver = {
  port: number;
  url(path?: string): string;
  requests: ReceivedRequest[];
  /** Số kết nối TCP đã nhận (W-22: chặn ở lookup thì không có kết nối nào). */
  connections(): number;
  /** Hàng đợi response; hết hàng thì 204. */
  respondWith(...r: ReceiverResponse[]): void;
  /** Giữ mọi request mới (không trả lời) tới khi `release()`: ép xen kẽ "đang gửi" (R6-9, R6-11). */
  hold(): void;
  release(): void;
  waitFor(n: number, timeoutMs?: number): Promise<ReceivedRequest[]>;
  close(): Promise<void>;
};
const POLL_MS = 20;
const DEFAULT_WAIT_MS = 10_000;

/** Receiver HTTP trên 127.0.0.1, cổng tự chọn; chỉ ở test/. */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: ReceivedRequest[] = [];
  const queue: ReceiverResponse[] = [];
  let held: (() => void)[] | undefined;
  let connections = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() });
      const reply = () => {
        const r = queue.shift() ?? { status: 204 };
        setTimeout(() => {
          res.writeHead(r.status, r.headers);
          res.end(r.body);
        }, r.delayMs ?? 0);
      };
      if (held) held.push(reply);
      else reply();
    });
  });
  server.on('connection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    requests,
    connections: () => connections,
    respondWith: (...r) => queue.push(...r),
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = undefined;
      for (const reply of waiting) reply();
    },
    waitFor: async (n, timeoutMs = DEFAULT_WAIT_MS) => {
      const until = Date.now() + timeoutMs;
      while (requests.length < n) {
        if (Date.now() > until) throw new Error(`receiver: ${requests.length} of ${n} requests within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return requests.slice(0, n);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```
(`server.address()` trả `AddressInfo` sau `listen` trên TCP: ép kiểu hẹp có lý do, không `any`.)

`test/support/integrations-delivery.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { OrgScope } from '../../src/core/database/index.js';
import type { JobContext } from '../../src/core/queue/index.js';
import { DeliverWebhookHandler } from '../../src/modules/integrations/application/deliver-webhook.handler.js';
import { WebhookSecrets } from '../../src/modules/integrations/application/webhook-secrets.js';
import { inOrg, insertDelivery, insertEndpoint, insertMessage, orgQuery, type SeededEndpoint, type SeededMessage } from './integrations-seed.js';
import type { WebhookReceiver } from './webhook-receiver.js';

/** Cho phép gửi tới receiver trên 127.0.0.1 (chỉ test; production chỉ https và không allowlist loopback). */
export const receiverEnv = (r: WebhookReceiver): Record<string, string> => ({
  RESILIENCE_ALLOWED_SCHEMES: 'http,https',
  RESILIENCE_ALLOWED_PORTS: `80,443,${r.port}`,
  RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
});
export const jobCtx = (deliveryId: string, orgId: string): JobContext<{ deliveryId: string }> => ({
  payload: { deliveryId },
  meta: { orgId },
  jobId: `test-${v7()}`,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
/** Một lần chạy handler gửi trong OrgScope của org (WorkerHost làm đúng việc này với `meta.orgId`). */
export const runDeliver = (app: INestApplication, orgId: string, deliveryId: string): Promise<void> =>
  app.get(OrgScope).run(orgId, () => app.get(DeliverWebhookHandler).handle(jobCtx(deliveryId, orgId)));

export type SeededDelivery = { deliveryId: string; endpoint: SeededEndpoint; message: SeededMessage; secret: string };
/** Endpoint (URL cho trước) + một secret thật mã hoá bằng `WebhookSecrets` của app + message + delivery `PENDING` đến hạn. */
export async function seedPendingDelivery(
  app: INestApplication,
  orgId: string,
  o: { url: string; eventType?: string; body?: string; endpoint?: SeededEndpoint },
): Promise<SeededDelivery> {
  const secrets = app.get(WebhookSecrets);
  const secret = secrets.generate();
  return inOrg(orgId, async (c) => {
    const endpoint = o.endpoint ?? (await insertEndpoint(c, orgId, { url: o.url, eventTypes: [o.eventType ?? 'tenancy.org.updated'] }));
    if (!o.endpoint) {
      const secretPublicId = v7();
      await c.query(`INSERT INTO webhook_endpoint_secrets (public_id, org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3, $4)`, [
        secretPublicId,
        orgId,
        endpoint.id,
        secrets.seal(secret, { orgId, secretPublicId }),
      ]);
    }
    const message = await insertMessage(c, orgId, { eventType: o.eventType, body: o.body ?? '{"type":"tenancy.org.updated","version":1}' });
    const { publicId } = await insertDelivery(c, orgId, { endpoint, message });
    return { deliveryId: publicId, endpoint, message, secret };
  });
}
export type DeliveryDbRow = {
  status: string;
  attempts_total: number;
  cycle_base: number;
  local_failures: number;
  last_error: string | null;
  last_status_code: number | null;
  next_in_ms: number | null;
  lease_until: Date | null;
  completed_at: Date | null;
};
export async function deliveryRow(orgId: string, deliveryId: string): Promise<DeliveryDbRow> {
  const [r] = await orgQuery<DeliveryDbRow>(
    orgId,
    `SELECT status, attempts_total, cycle_base, local_failures, last_error, last_status_code, lease_until, completed_at,
            (extract(epoch FROM next_attempt_at - clock_timestamp()) * 1000)::int AS next_in_ms
     FROM webhook_deliveries WHERE public_id = $1`,
    [deliveryId],
  );
  if (!r) throw new Error(`delivery ${deliveryId} not found`);
  return r;
}
/** Đưa lần hẹn kế về "đến hạn ngay" (thay vì chờ lịch). */
export const makeDue = (orgId: string, deliveryId: string) =>
  orgQuery(orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1 AND next_attempt_at IS NOT NULL`, [deliveryId]);
```

- [ ] **Step 2: Test e2e (fail)**

`test/e2e/integrations/deliver.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../src/core/database/index.js';
import { DbKillSwitchProvider, KillSwitches, NO_ROW_VERSION } from '../../../src/core/flags/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import { deliveryRow, makeDue, receiverEnv, runDeliver, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

/** Lịch ngắn (W-10): 3 bước → 4 lần thử. */
const SCHEDULE = [1, 2, 3];
const deferredJobs = (orgId: string, deliveryId: string) =>
  ownerQuery<{ payload: { jobId: string; delayMs?: number } }>(
    `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
    [orgId, deliveryId],
  );

describe('sending a webhook (spec SP6 §8.3 "Gửi", §7.2)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: { ...receiverEnv(receiver), INTEGRATIONS_RETRY_SCHEDULE_SEC: SCHEDULE.join(','), INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '86400' },
    });
    org = await seedOrg();
  });
  beforeEach(() => {
    receiver.requests.length = 0;
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('2xx → SUCCEEDED; Standard Webhooks headers verify with the secret (W-1); webhook-id is the event id; timestamp is unix seconds at send (W-4); user-agent', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const before = Math.floor(Date.now() / 1000);
    await runDeliver(app, org.orgId, d.deliveryId);
    const [req] = await receiver.waitFor(1);
    const [msg] = await orgQuery<{ event_id: string; body: string }>(org.orgId, `SELECT event_id::text, body FROM webhook_messages WHERE id = $1`, [d.message.id]);
    expect(req?.body).toBe(msg?.body);
    expect(req?.headers['webhook-id']).toBe(msg?.event_id);
    expect(Number(req?.headers['webhook-timestamp'])).toBeGreaterThanOrEqual(before);
    expect(req?.headers['content-type']).toBe('application/json');
    expect(String(req?.headers['user-agent'])).toMatch(/-webhooks\/1$/);
    expect(() =>
      new Webhook(d.secret).verify(req?.body ?? '', {
        'webhook-id': String(req?.headers['webhook-id']),
        'webhook-timestamp': String(req?.headers['webhook-timestamp']),
        'webhook-signature': String(req?.headers['webhook-signature']),
      }),
    ).not.toThrow();
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'SUCCEEDED', attempts_total: 1, last_status_code: 204, lease_until: null });
  });
  it('W-10/W-11: 500 every time → RETRY_SCHEDULED per schedule (jobs a2..a4 with the scheduled delay ±10%), then EXHAUSTED after 4 attempts + exhausted event', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    for (let attempt = 1; attempt <= SCHEDULE.length + 1; attempt++) {
      receiver.respondWith({ status: 500 });
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row.attempts_total).toBe(attempt);
      if (attempt <= SCHEDULE.length) {
        expect(row).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'SERVER_ERROR', last_status_code: 500 });
        const step = (SCHEDULE[attempt - 1] ?? 0) * 1000;
        expect(row.next_in_ms).toBeGreaterThan(step * 0.9 - 500);
        expect(row.next_in_ms).toBeLessThanOrEqual(step * 1.1);
        await makeDue(org.orgId, d.deliveryId);
      } else expect(row).toMatchObject({ status: 'EXHAUSTED', last_error: 'SERVER_ERROR' });
    }
    expect((await deferredJobs(org.orgId, d.deliveryId)).map((j) => j.payload.jobId)).toEqual([
      `webhook-${d.deliveryId}-a2`,
      `webhook-${d.deliveryId}-a3`,
      `webhook-${d.deliveryId}-a4`,
    ]);
    const exhausted = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`,
      [org.orgId, d.deliveryId],
    );
    expect(exhausted.map((e) => e.payload)).toEqual([
      { deliveryId: d.deliveryId, endpointId: d.endpoint.publicId, eventType: 'tenancy.org.updated', eventId: expect.any(String) },
    ]);
  });
  it('W-14 + Review Focus 3: 429 with Retry-After larger than the step is a floor; without it the schedule applies', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.respondWith({ status: 429, headers: { 'retry-after': '120' } });
    await runDeliver(app, org.orgId, d.deliveryId);
    const row = await deliveryRow(org.orgId, d.deliveryId);
    expect(row).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'RATE_LIMITED', last_status_code: 429 });
    expect(row.next_in_ms).toBeGreaterThan(119_000);
    expect(row.next_in_ms).toBeLessThanOrEqual(120_000);
    await makeDue(org.orgId, d.deliveryId);
    receiver.respondWith({ status: 429 });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).next_in_ms).toBeLessThanOrEqual((SCHEDULE[1] ?? 0) * 1100);
  });
  it('W-15: a 302 is not followed and is a REDIRECT failure; a 410 is CLIENT_ERROR', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.respondWith({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'REDIRECT', last_status_code: 302 });
    expect(receiver.requests).toHaveLength(1);
    await makeDue(org.orgId, d.deliveryId);
    receiver.respondWith({ status: 410 });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ last_error: 'CLIENT_ERROR', last_status_code: 410 });
  });
  it('W-24: a response over RESILIENCE_MAX_RESPONSE_BYTES is TOO_LARGE', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.respondWith({ status: 200, body: 'x'.repeat(11 * 1024 * 1024) });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'TOO_LARGE' });
  });
  it('R6-10 / R6-25 / W-33: a delivery whose endpoint was disabled or deleted is CANCELLED at claim (ENDPOINT_UNAVAILABLE), nothing is sent', async () => {
    const disabled = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`, [disabled.endpoint.id]);
    const deleted = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [deleted.endpoint.id]);
    for (const d of [disabled, deleted]) {
      await runDeliver(app, org.orgId, d.deliveryId);
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'CANCELLED', last_error: 'ENDPOINT_UNAVAILABLE', attempts_total: 1 });
    }
    expect(receiver.requests).toHaveLength(0);
  });
  it('R6C-1: a job that runs before next_attempt_at (duplicate or early) does nothing', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE public_id = $1`, [d.deliveryId]);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'PENDING', attempts_total: 0 });
    expect(receiver.requests).toHaveLength(0);
  });
  it('W-45: with integrations.webhook_delivery killed nothing goes out, the attempt is not counted, a recheck job is deferred; turning it off sends', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const switches = app.get(KillSwitches);
    const set = (killed: boolean, expectedVersion: number) =>
      app.get(UnitOfWork).run(() =>
        switches.set({ key: 'integrations.webhook_delivery', killed, reason: killed ? 'incident' : null, actor: 'test', expectedVersion }),
      );
    const states = await switches.list();
    const current = states.find((s) => s.key === 'integrations.webhook_delivery')?.version ?? NO_ROW_VERSION;
    const on = await set(true, current);
    expect(on.kind).toBe('APPLIED');
    await app.get(DbKillSwitchProvider).refreshOnce();
    try {
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({ status: 'PENDING', attempts_total: 0 });
      expect(row.next_in_ms).toBeGreaterThan(50_000);
      expect(receiver.requests).toHaveLength(0);
      expect((await deferredJobs(org.orgId, d.deliveryId)).map((j) => j.payload.jobId)).toEqual([
        expect.stringMatching(new RegExp(`^webhook-${d.deliveryId}-a1-k\\d+$`)),
      ]);
      // M1: một job trùng/tới sớm khi đang bị kill không kéo lần hẹn muộn hơn về sớm, không đẩy lùi thêm, không sinh job mới.
      const later = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
      await orgQuery(org.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE public_id = $1`, [later.deliveryId]);
      await runDeliver(app, org.orgId, later.deliveryId);
      const untouched = await deliveryRow(org.orgId, later.deliveryId);
      expect(untouched.next_in_ms).toBeGreaterThan(3_500_000);
      expect(untouched.next_in_ms).toBeLessThanOrEqual(3_600_000);
      expect(await deferredJobs(org.orgId, later.deliveryId)).toEqual([]);
    } finally {
      await set(false, on.kind === 'APPLIED' ? on.version : current);
      await app.get(DbKillSwitchProvider).refreshOnce();
    }
    await makeDue(org.orgId, d.deliveryId);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe('SUCCEEDED');
  });
  it('a success clears failing_since on the endpoint without bumping its version (ETag of the customer stays valid)', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE id = $1`, [d.endpoint.id]);
    await runDeliver(app, org.orgId, d.deliveryId);
    const [ep] = await orgQuery<{ failing_since: Date | null; version: number }>(org.orgId, `SELECT failing_since, version FROM webhook_endpoints WHERE id = $1`, [
      d.endpoint.id,
    ]);
    expect(ep).toEqual({ failing_since: null, version: 1 });
  });
});
```
`test/e2e/integrations/deliver-ssrf.e2e.spec.ts` (W-20…W-23 lúc gửi; không allowlist loopback):
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRow, runDeliver, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

describe('SSRF at send time (spec SP6 §8.3, W-22, W-23)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    // http + cổng của receiver được phép, nhưng KHÔNG allowlist 127.0.0.1: chỉ lookup lúc connect còn đứng giữa.
    app = await startIntegrationsApp({ env: { RESILIENCE_ALLOWED_SCHEMES: 'http,https', RESILIENCE_ALLOWED_PORTS: `80,443,${receiver.port}` } });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('W-22 (DNS rebinding): a name that looked public at registration and resolves to loopback at send is SSRF_BLOCKED, with no connection', async () => {
    // Đăng ký đã qua `UrlGuard` với resolver giả (`PUBLIC_IP`); lúc gửi, DNS thật của máy phân giải `localhost` ra 127.0.0.1.
    const d = await seedPendingDelivery(app, org.orgId, { url: `http://localhost:${receiver.port}/hook` });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'SSRF_BLOCKED' });
    expect(receiver.connections()).toBe(0);
  });
  it('an IP literal stored by direct SQL (bypassing the API guard) is still refused before any connection', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: `http://127.0.0.1:${receiver.port}/hook` });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ last_error: 'SSRF_BLOCKED' });
    expect(receiver.connections()).toBe(0);
  });
});
```
(W-23 "redirect về địa chỉ nội bộ không được theo" có ở ca W-15 của `deliver.e2e.spec.ts`: 302 tới `169.254.169.254`, receiver nhận đúng một request, không ai đi theo `location`.)

`test/e2e/integrations/deliver-local-faults.e2e.spec.ts` (W-34 phần integration + R-X35; `HttpClient` giả trả `bulkhead_full`):
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, UpstreamError } from '../../../src/core/resilience/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import { deliveryRow, makeDue, runDeliver, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { FAKE_SECRET_ENC, inOrg, orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** `INTEGRATIONS_MAX_LOCAL_FAILURES` của app test (bằng mặc định, ghi tường minh để test không lệ thuộc mặc định). */
const MAX = 5;
const exhaustedEvents = (orgId: string, deliveryId: string) =>
  ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`, [
    orgId,
    deliveryId,
  ]);
const deferredJobIds = async (orgId: string, deliveryId: string) =>
  (
    await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
      [orgId, deliveryId],
    )
  ).map((j) => j.payload.jobId);

describe('faults on our side never burn the schedule nor disable a healthy endpoint, and are capped (spec SP6 §7.2, S6-A49, W-34, R6-28, R-X35)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let calls = 0;
  beforeAll(async () => {
    const fake = {
      request: async () => {
        calls++;
        throw new UpstreamError('webhooks-out', 'bulkhead_full', 'Upstream webhooks-out bulkhead is full');
      },
    };
    app = await startIntegrationsApp({
      // DISABLE_AFTER nhỏ nhất hợp lệ với lịch 1 bước (1 s): sau đó endpoint "lỗi lâu" sẽ bị tắt nếu lỗi của ta bị tính nhầm.
      env: {
        INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
        INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
        INTEGRATIONS_LOCAL_FAULT_RETRY_SEC: '1',
        INTEGRATIONS_MAX_LOCAL_FAILURES: String(MAX),
      },
      configure: (b) => b.overrideProvider(HttpClient).useValue(fake),
    });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it(`W-34 + R-X35: ${MAX - 1} bulkhead_full keep the schedule and the endpoint; the ${MAX}th exhausts the delivery (recoverable); the endpoint stays ACTIVE and healthy past DISABLE_AFTER`, async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: 'https://hooks.example.test/x' });
    for (let i = 1; i < MAX; i++) {
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'BULKHEAD_FULL', attempts_total: i, local_failures: i });
      // Không bước lịch nào bị tiêu: mỗi lỗi của ta tăng `cycle_base` cùng `attempts_total`.
      expect(row.attempts_total - row.cycle_base).toBe(0);
      await makeDue(org.orgId, d.deliveryId);
    }
    // Đưa đồng hồ qua mốc DISABLE_AFTER = 1 s: nếu lỗi của ta bị tính nhầm là lỗi của endpoint, lần cuối sẽ tự tắt endpoint.
    await new Promise((r) => setTimeout(r, 1100));
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'EXHAUSTED',
      last_error: 'BULKHEAD_FULL',
      attempts_total: MAX,
      local_failures: MAX,
      lease_until: null,
    });
    expect(await exhaustedEvents(org.orgId, d.deliveryId)).toHaveLength(1);
    expect(await deferredJobIds(org.orgId, d.deliveryId)).toEqual(Array.from({ length: MAX - 1 }, (_, i) => `webhook-${d.deliveryId}-a${i + 2}`));
    const [ep] = await orgQuery<{ status: string; failing_since: Date | null }>(org.orgId, `SELECT status, failing_since FROM webhook_endpoints WHERE id = $1`, [
      d.endpoint.id,
    ]);
    expect(ep).toEqual({ status: 'ACTIVE', failing_since: null });
  });
  it(`R-X35: an undecryptable signing secret is a counted local failure (SECRET_UNAVAILABLE) recorded at claim, nothing is sent, the ${MAX}th exhausts — no endless re-enqueue`, async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: 'https://hooks.example.test/y' });
    // app_user không có UPDATE trên `secret_enc`: thay secret bằng một token đúng định dạng mà keyring không giải mã được.
    await inOrg(org.orgId, async (c) => {
      await c.query(`DELETE FROM webhook_endpoint_secrets WHERE endpoint_id = $1`, [d.endpoint.id]);
      await c.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`, [org.orgId, d.endpoint.id, FAKE_SECRET_ENC]);
    });
    const before = calls;
    for (let i = 1; i <= MAX; i++) {
      await runDeliver(app, org.orgId, d.deliveryId);
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: i < MAX ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
        last_error: 'SECRET_UNAVAILABLE',
        attempts_total: i,
        local_failures: i,
        lease_until: null,
      });
      await makeDue(org.orgId, d.deliveryId);
    }
    expect(calls).toBe(before);
    expect(await deferredJobIds(org.orgId, d.deliveryId)).toEqual(Array.from({ length: MAX - 1 }, (_, i) => `webhook-${d.deliveryId}-a${i + 2}`));
    expect(await exhaustedEvents(org.orgId, d.deliveryId)).toHaveLength(1);
  });
});
```
(`setTimeout(1100)` ở đây không phải chờ may rủi của race: nó chỉ đưa đồng hồ qua mốc `DISABLE_AFTER = 1 s` để chứng minh lỗi của ta không đặt `failing_since`; kết quả tất định. Ca W-34 cũ đòi `attempts_total - cycle_base = 1` là sai số học: claim tăng `attempts_total`, kết quả LOCAL tăng `cycle_base` cùng CAS, nên hiệu là `0` sau mỗi lần; `1` chỉ đúng *giữa* claim và kết quả — đó là giá trị handler đưa cho `scheduledDelaySec`.)

`test/e2e/integrations/deliver-inflight.e2e.spec.ts` (R-X35 bulkhead in-flight, R6C-4; ép xen kẽ bằng receiver giữ request, không dựa vào thời gian):
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { deliveryRow, runDeliver, seedPendingDelivery, type SeededDelivery } from '../../support/integrations-delivery.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

const MAX_INFLIGHT = 4;
/** Bulkhead của process vừa trên trần in-flight: không có trần, endpoint chết lấp đầy bulkhead và endpoint khoẻ nhận `bulkhead_full`. */
const BULKHEAD = MAX_INFLIGHT + 1;
const PENDING = 10;
const SETTLE_DEADLINE_MS = 10_000;
const POLL_MS = 20;
const TEST_TIMEOUT_MS = 30_000;

describe('a hanging endpoint cannot take the shared webhooks-out bulkhead (R-X35 in-flight cap, R6C-4)', { timeout: TEST_TIMEOUT_MS }, () => {
  let app: INestApplication;
  let dead: WebhookReceiver;
  let healthy: WebhookReceiver;
  let orgA: SeededOrg;
  let orgB: SeededOrg;
  beforeAll(async () => {
    dead = await startWebhookReceiver();
    healthy = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        RESILIENCE_ALLOWED_SCHEMES: 'http,https',
        RESILIENCE_ALLOWED_PORTS: `80,443,${dead.port},${healthy.port}`,
        RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
        INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT: String(MAX_INFLIGHT),
        INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT: String(BULKHEAD),
        INTEGRATIONS_WEBHOOK_BULKHEAD_QUEUE: '0',
        // Luật `webhooks-bulkhead-covers-concurrency`: bulkhead ≥ concurrency của queue io.
        QUEUE_IO_CONCURRENCY: String(BULKHEAD),
        // Request bị giữ phải sống qua cả ca (timeout dưới lease 60 s, trên thời gian ca).
        INTEGRATIONS_WEBHOOK_TIMEOUT_MS: '20000',
        // 10 claim cùng lúc xếp hàng trên dòng endpoint, mỗi cái giữ một kết nối tới khi tới lượt: trên DB_POOL_MAX mặc định (10).
        DB_POOL_MAX: String(2 * PENDING + 2),
      },
    });
    orgA = await seedOrg();
    orgB = await seedOrg();
  });
  afterAll(async () => {
    dead?.release();
    await orgA?.dispose();
    await orgB?.dispose();
    await app?.close();
    await dead?.close();
    await healthy?.close();
  });

  it(`${PENDING} deliveries to a hanging endpoint hold exactly ${MAX_INFLIGHT} slots, the rest are deferred uncounted; a healthy endpoint of another org is delivered meanwhile`, async () => {
    const first = await seedPendingDelivery(app, orgA.orgId, { url: dead.url() });
    const all: SeededDelivery[] = [first];
    for (let i = 1; i < PENDING; i++) all.push(await seedPendingDelivery(app, orgA.orgId, { url: dead.url(), endpoint: first.endpoint }));
    dead.hold();
    let settled = 0;
    const runs = all.map((d) =>
      runDeliver(app, orgA.orgId, d.deliveryId).finally(() => {
        settled++;
      }),
    );
    // Xen kẽ bị ép: đúng MAX_INFLIGHT request đang bị receiver giữ (in-flight thật), các handler còn lại đã trả về vì claim
    // bị từ chối. Thứ tự claim không quan trọng: khoá dòng endpoint tuần tự hoá "đếm rồi claim".
    await dead.waitFor(MAX_INFLIGHT);
    const until = Date.now() + SETTLE_DEADLINE_MS;
    while (settled < PENDING - MAX_INFLIGHT) {
      if (Date.now() > until) throw new Error(`${settled} of ${PENDING - MAX_INFLIGHT} refused claims returned`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const rows = await orgQuery<{ status: string; attempts_total: number; local_failures: number; later: boolean | null }>(
      orgA.orgId,
      `SELECT status, attempts_total, local_failures, next_attempt_at > now() AS later FROM webhook_deliveries WHERE endpoint_id = $1`,
      [first.endpoint.id],
    );
    expect(rows.filter((r) => r.status === 'SENDING')).toHaveLength(MAX_INFLIGHT);
    const deferred = rows.filter((r) => r.status === 'PENDING');
    expect(deferred).toHaveLength(PENDING - MAX_INFLIGHT);
    for (const r of deferred) expect(r).toMatchObject({ attempts_total: 0, local_failures: 0, later: true });
    const busy = await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->>'job' = 'integrations.deliver-webhook'`,
      [orgA.orgId],
    );
    expect(busy.map((j) => j.payload.jobId).filter((id) => /-a1-b\d+$/.test(id))).toHaveLength(PENDING - MAX_INFLIGHT);
    // Endpoint khoẻ của org khác vẫn có slot bulkhead trong khi endpoint chết giữ đúng MAX_INFLIGHT.
    const ok = await seedPendingDelivery(app, orgB.orgId, { url: healthy.url() });
    await runDeliver(app, orgB.orgId, ok.deliveryId);
    expect((await deliveryRow(orgB.orgId, ok.deliveryId)).status).toBe('SUCCEEDED');
    expect(dead.requests).toHaveLength(MAX_INFLIGHT);
    dead.release();
    await Promise.all(runs);
    const done = await orgQuery<{ n: number }>(
      orgA.orgId,
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'SUCCEEDED'`,
      [first.endpoint.id],
    );
    expect(done[0]?.n).toBe(MAX_INFLIGHT);
  });
});
```
(RED: tạm cho `lockForClaim` trả `0` → `dead.requests` lên `BULKHEAD`, delivery của org B thành `RETRY_SCHEDULED` với `BULKHEAD_FULL`; hoàn nguyên, ghi vào báo cáo task. Vòng chờ `settled` là chờ handler đã bị từ chối trả về, có hạn chót, không phải ép xen kẽ.)

`test/e2e/integrations/webhook-flow.e2e.spec.ts` (luồng thật: route tenancy → outbox → relay → dispatch → fan-out → job thật → receiver; W-40 phần org xoá mềm):
```ts
import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../../src/core/queue/index.js';
import { IntegrationsSweepOrgJob } from '../../../src/modules/integrations/jobs.js';
import { endpointsUrl, startIntegrationsApp } from '../../support/integrations-app.js';
import { deliveryRow, receiverEnv, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

const FLOW_TIMEOUT_MS = 30_000;

describe('end-to-end webhook flow on real jobs (spec SP6 §8.3, W-1, W-40)', { timeout: FLOW_TIMEOUT_MS }, () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  let secret: string;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({ env: receiverEnv(receiver), consumeWebhooks: true });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({ url: receiver.url('/flow'), eventTypes: ['tenancy.org.updated', 'tenancy.org.deleted'] });
    expect(res.status).toBe(201);
    secret = String(res.body.secret);
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('renaming the org reaches the receiver signed, with the tenancy.org.updated payload', async () => {
    const get = await authed(app, owner).get(`/v1/orgs/${org.orgId}`);
    const patch = await authed(app, owner).patch(`/v1/orgs/${org.orgId}`).set('if-match', String(get.headers.etag)).send({ name: 'Renamed Org' });
    expect(patch.status).toBe(200);
    const [req] = await receiver.waitFor(1, FLOW_TIMEOUT_MS - 5000);
    const payload = new Webhook(secret).verify(req?.body ?? '', {
      'webhook-id': String(req?.headers['webhook-id']),
      'webhook-timestamp': String(req?.headers['webhook-timestamp']),
      'webhook-signature': String(req?.headers['webhook-signature']),
    });
    expect(payload).toMatchObject({ type: 'tenancy.org.updated', version: 1, data: { orgId: org.orgId, changed: ['name'] } });
  });
  it('W-40: soft-deleting the org still delivers tenancy.org.deleted (deliver job runs for an inactive org)', async () => {
    expect((await authed(app, owner).delete(`/v1/orgs/${org.orgId}`)).status).toBe(204);
    const reqs = await receiver.waitFor(2, FLOW_TIMEOUT_MS - 5000);
    expect(JSON.parse(reqs[1]?.body ?? '{}')).toMatchObject({ type: 'tenancy.org.deleted' });
  });
  it('W-40 + I4: in the soft-deleted org an expired lease is still rescheduled by integrations.sweep-org through the real WorkerHost (onInactiveOrg run)', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url('/flow') });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 1, lease_until = now() - interval '1 hour' WHERE public_id = $1`,
      [d.deliveryId],
    );
    await app.get(JobQueue).enqueue(IntegrationsSweepOrgJob, {}, { jobId: `w40-sweep-${d.deliveryId}`, meta: { orgId: org.orgId } });
    // Chờ worker của app chạy job (có hạn chót). `onInactiveOrg: 'skip'` sẽ để dòng ở SENDING tới hết hạn chót → đỏ.
    const until = Date.now() + FLOW_TIMEOUT_MS - 5000;
    while ((await deliveryRow(org.orgId, d.deliveryId)).status === 'SENDING' && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'LEASE_EXPIRED', local_failures: 1 });
  });
});
```
(Route của 3A đã đối chiếu: `PATCH /v1/orgs/:orgId` đòi `If-Match` (`org.controller.ts:51-69`), `DELETE /v1/orgs/:orgId` trả `204` không đòi `If-Match` (`org.controller.ts:71-77`); cả hai `@SensitiveTenancyAction()`, principal seed có session mới và email đã xác thực.)

Run:
```bash
pnpm vitest run --project integration test/e2e/integrations/deliver.e2e.spec.ts test/e2e/integrations/deliver-ssrf.e2e.spec.ts test/e2e/integrations/deliver-local-faults.e2e.spec.ts test/e2e/integrations/deliver-inflight.e2e.spec.ts test/e2e/integrations/webhook-flow.e2e.spec.ts
```
Expected: FAIL (`DeliverWebhookHandler` chưa có). `sweep.spec.ts` viết ở Step 5.

- [ ] **Step 3: Repository — claim, kết quả, kill switch, đường gửi của endpoint**

`src/modules/integrations/ports/delivery-repository.ts`: thêm vào lớp
```ts
  /** Endpoint của delivery còn claim được và đã đến hạn (± `skewMs`); không khoá — claim khoá endpoint trước (R-X35). */
  abstract dueEndpointOf(publicId: string, skewMs: number): Promise<string | undefined>;
  /** CAS `PENDING | RETRY_SCHEDULED → SENDING` khi đã đến hạn (± `skewMs`); `undefined` = không claim được (R6-9, R6C-1). */
  abstract claim(publicId: string, leaseMs: number, skewMs: number): Promise<ClaimedDelivery | undefined>;
  /** `SENDING → CANCELLED(ENDPOINT_UNAVAILABLE)` trong cùng transaction claim. */
  abstract cancelClaimed(ref: DeliveryRef, attempts: number): Promise<boolean>;
  abstract messageOf(ref: DeliveryRef & { messageId: string }): Promise<{ eventId: string; eventType: string; body: string }>;
  /** Id công khai của endpoint và event của message (event `exhausted` khi không có `Send` trong tay: sweep, secret hỏng). */
  abstract describe(ref: DeliveryRef & { endpointId: string; messageId: string }): Promise<{ endpointPublicId: string; eventType: string; eventId: string }>;
  /** CAS có fencing: `status = 'SENDING' AND attempts_total = attempts`; `false` = một lần claim khác đã thắng (R6-9). */
  abstract finish(ref: DeliveryRef, attempts: number, result: DeliveryResult): Promise<boolean>;
  /**
   * `DEFER` (kill switch, endpoint đủ in-flight): `next_attempt_at = GREATEST(next_attempt_at, now + delay)`, chỉ khi đã đến
   * hạn (± `skewMs`) — M1: job trùng/tới sớm không kéo lần hẹn muộn về sớm, không đẩy lùi thêm. Không claim, không đếm;
   * trả `attempts_total` khi đã dời, `undefined` khi không (khi đó không enqueue gì: job đúng hạn của lần hẹn đó vẫn còn).
   */
  abstract defer(publicId: string, delayMs: number, skewMs: number): Promise<number | undefined>;
```
`src/modules/integrations/infra/sql/sql-delivery.repository.ts`: thêm (import `type ClaimedDelivery, type DeliveryRef, type DeliveryResult`):
```ts
const ClaimRow = z.array(
  z.object({
    id: z.string(),
    public_id: z.uuid(),
    created_at: z.string(),
    created_at_ms: z.number(),
    endpoint_id: z.string(),
    message_id: z.string(),
    attempts_total: z.number().int(),
    cycle_base: z.number().int(),
    local_failures: z.number().int(),
  }),
);
const toClaimed = (r: z.infer<typeof ClaimRow>[number]): ClaimedDelivery => ({
  id: r.id,
  publicId: r.public_id,
  createdAt: r.created_at,
  createdAtMs: r.created_at_ms,
  endpointId: r.endpoint_id,
  messageId: r.message_id,
  attemptsTotal: r.attempts_total,
  cycleBase: r.cycle_base,
  localFailures: r.local_failures,
});
const OkRows = z.array(z.object({ ok: z.number() }));
const ROW_KEY = `org_id = app_current_org() AND id = ?::bigint AND created_at = ?::timestamptz`;
const FENCE = `status = 'SENDING' AND attempts_total = ?::integer`;
```
và vào lớp:
```ts
  async dueEndpointOf(publicId: string, skewMs: number): Promise<string | undefined> {
    const [r] = z
      .array(z.object({ endpoint_id: z.string() }))
      .parse(
        await this.db.execute(
          `SELECT endpoint_id::text AS endpoint_id FROM webhook_deliveries
           WHERE org_id = app_current_org() AND public_id = ?::uuid AND status IN ('PENDING', 'RETRY_SCHEDULED')
             AND next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)`,
          [publicId, skewMs],
        ),
      );
    return r?.endpoint_id;
  }
  async claim(publicId: string, leaseMs: number, skewMs: number): Promise<ClaimedDelivery | undefined> {
    const [r] = ClaimRow.parse(
      await this.db.execute(
        `UPDATE webhook_deliveries AS d SET status = 'SENDING', attempts_total = d.attempts_total + 1, next_attempt_at = NULL,
           lease_until = clock_timestamp() + make_interval(secs => ?::double precision / 1000), last_attempt_at = clock_timestamp(),
           version = d.version + 1, updated_at = clock_timestamp()
         WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid AND d.status IN ('PENDING', 'RETRY_SCHEDULED')
           AND d.next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)
         RETURNING d.id::text AS id, d.public_id::text AS public_id, ${CREATED_AT_KEY_SQL('d')} AS created_at,
           (extract(epoch FROM d.created_at) * 1000)::float8 AS created_at_ms, d.endpoint_id::text AS endpoint_id,
           d.message_id::text AS message_id, d.attempts_total, d.cycle_base, d.local_failures`,
        [leaseMs, publicId, skewMs],
      ),
    );
    return r ? toClaimed(r) : undefined;
  }
  async cancelClaimed(ref: DeliveryRef, attempts: number): Promise<boolean> {
    return (
      OkRows.parse(
        await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'CANCELLED', lease_until = NULL, completed_at = clock_timestamp(), last_error = 'ENDPOINT_UNAVAILABLE',
             version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [ref.id, ref.createdAt, attempts],
        ),
      ).length === 1
    );
  }
  async messageOf(ref: DeliveryRef & { messageId: string }): Promise<{ eventId: string; eventType: string; body: string }> {
    const [r] = z
      .array(z.object({ event_id: z.uuid(), event_type: z.string(), body: z.string() }))
      .parse(
        await this.db.execute(
          `SELECT event_id::text AS event_id, event_type, body FROM webhook_messages
           WHERE org_id = app_current_org() AND id = ?::bigint AND created_at = ?::timestamptz`,
          [ref.messageId, ref.createdAt],
        ),
      );
    if (!r) throw new Error(`webhook message of delivery ${ref.publicId} is missing (FK should make this impossible)`);
    return { eventId: r.event_id, eventType: r.event_type, body: r.body };
  }
  async describe(
    ref: DeliveryRef & { endpointId: string; messageId: string },
  ): Promise<{ endpointPublicId: string; eventType: string; eventId: string }> {
    const [r] = z
      .array(z.object({ endpoint_public_id: z.uuid(), event_type: z.string(), event_id: z.uuid() }))
      .parse(
        await this.db.execute(
          `SELECT e.public_id::text AS endpoint_public_id, m.event_type, m.event_id::text AS event_id
           FROM webhook_messages m JOIN webhook_endpoints e ON e.org_id = m.org_id AND e.id = ?::bigint
           WHERE m.org_id = app_current_org() AND m.id = ?::bigint AND m.created_at = ?::timestamptz`,
          [ref.endpointId, ref.messageId, ref.createdAt],
        ),
      );
    // Bất biến R-X33 (mọi delivery có endpoint) bị vỡ là bug: fail to, không đoán.
    if (!r) throw new Error(`delivery ${ref.publicId} has no message or no endpoint row (R-X33 invariant broken)`);
    return { endpointPublicId: r.endpoint_public_id, eventType: r.event_type, eventId: r.event_id };
  }
  async finish(ref: DeliveryRef, attempts: number, result: DeliveryResult): Promise<boolean> {
    const key = [ref.id, ref.createdAt, attempts];
    let rows: object[];
    switch (result.kind) {
      case 'SUCCEEDED':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'SUCCEEDED', lease_until = NULL, completed_at = clock_timestamp(), last_status_code = ?::integer,
             last_error = NULL, version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [result.statusCode, ...key],
        );
        break;
      case 'RETRY':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'RETRY_SCHEDULED', lease_until = NULL,
             next_attempt_at = clock_timestamp() + make_interval(secs => ?::double precision / 1000), cycle_base = cycle_base + ?::integer,
             local_failures = local_failures + ?::integer, last_status_code = ?::integer, last_error = ?, version = version + 1,
             updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [result.delayMs, result.cycleBump, result.localBump, result.statusCode, result.error, ...key],
        );
        break;
      case 'EXHAUSTED':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'EXHAUSTED', lease_until = NULL, completed_at = clock_timestamp(), last_status_code = ?::integer,
             last_error = ?, local_failures = local_failures + ?::integer, version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [result.statusCode, result.error, result.localBump, ...key],
        );
        break;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled delivery result ${JSON.stringify(unreachable)}`);
      }
    }
    return OkRows.parse(rows).length === 1;
  }
  async defer(publicId: string, delayMs: number, skewMs: number): Promise<number | undefined> {
    const [r] = z
      .array(z.object({ attempts_total: z.number().int() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_deliveries
           SET next_attempt_at = GREATEST(next_attempt_at, clock_timestamp() + make_interval(secs => ?::double precision / 1000)),
               updated_at = clock_timestamp()
           WHERE org_id = app_current_org() AND public_id = ?::uuid AND status IN ('PENDING', 'RETRY_SCHEDULED')
             AND next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)
           RETURNING attempts_total`,
          [delayMs, publicId, skewMs],
        ),
      );
    return r?.attempts_total;
  }
```
`src/modules/integrations/ports/endpoint-repository.ts`: thêm
```ts
  /**
   * R-X35, R6C-4: khoá dòng endpoint `FOR NO KEY UPDATE` (tuần tự hoá "đếm rồi claim" của mọi claim cùng endpoint), rồi đếm
   * delivery `SENDING` còn lease. `undefined` = không có dòng endpoint (claim sẽ huỷ delivery).
   */
  abstract lockForClaim(endpointId: string): Promise<number | undefined>;
  abstract forSend(endpointId: string): Promise<{ publicId: string; url: string; status: EndpointStatus; deleted: boolean } | undefined>;
  /** Thành công: `failing_since = NULL` (không tăng version: ETag của khách không đổi vì sức khoẻ). */
  abstract clearFailing(endpointId: string): Promise<void>;
  /** Lỗi của endpoint: `failing_since = COALESCE(failing_since, now)` (R6-12). */
  abstract markFailing(endpointId: string): Promise<void>;
  /** CAS `ACTIVE → DISABLED(AUTO_FAILING)` khi `failing_since <= now - afterSec`; đúng một người thắng (R6-12). */
  abstract autoDisable(endpointId: string, afterSec: number): Promise<{ publicId: string; version: number } | undefined>;
```
`src/modules/integrations/infra/sql/sql-endpoint.repository.ts`: thêm
```ts
  async lockForClaim(endpointId: string): Promise<number | undefined> {
    const locked = await this.db.execute(
      `SELECT 1 AS ok FROM webhook_endpoints WHERE org_id = app_current_org() AND id = ?::bigint FOR NO KEY UPDATE`,
      [endpointId],
    );
    if (locked.length === 0) return undefined;
    // Câu RIÊNG sau khi có khoá: snapshot mới (READ COMMITTED) thấy claim mà transaction vừa nhả khoá đã commit. Gộp đếm vào
    // câu khoá thì snapshot lấy TRƯỚC lúc chờ khoá, hai claim cùng thấy N-1 và cùng claim (vượt trần). Lease đã hết hạn không
    // tính: worker đã chết, sweep sẽ hẹn lại.
    const [r] = CountRow.parse(
      await this.db.execute(
        `SELECT count(*)::int AS n FROM webhook_deliveries
         WHERE org_id = app_current_org() AND endpoint_id = ?::bigint AND status = 'SENDING' AND lease_until > clock_timestamp()`,
        [endpointId],
      ),
    );
    if (!r) throw new Error('count of in-flight webhook deliveries returned no row');
    return r.n;
  }
  async forSend(endpointId: string): Promise<{ publicId: string; url: string; status: EndpointStatus; deleted: boolean } | undefined> {
    const [r] = z
      .array(z.object({ public_id: z.uuid(), url: z.string(), status: z.enum(ENDPOINT_STATUSES), deleted: z.boolean() }))
      .parse(
        await this.db.execute(
          `SELECT public_id::text AS public_id, url, status, deleted_at IS NOT NULL AS deleted FROM webhook_endpoints
           WHERE org_id = app_current_org() AND id = ?::bigint`,
          [endpointId],
        ),
      );
    return r ? { publicId: r.public_id, url: r.url, status: r.status, deleted: r.deleted } : undefined;
  }
  async clearFailing(endpointId: string): Promise<void> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET failing_since = NULL, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND failing_since IS NOT NULL`,
      [endpointId],
    );
  }
  async markFailing(endpointId: string): Promise<void> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET failing_since = clock_timestamp(), updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND failing_since IS NULL`,
      [endpointId],
    );
  }
  async autoDisable(endpointId: string, afterSec: number): Promise<{ publicId: string; version: number } | undefined> {
    const [r] = z
      .array(z.object({ public_id: z.uuid(), version: z.number().int() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'AUTO_FAILING', version = version + 1, updated_at = clock_timestamp()
           WHERE org_id = app_current_org() AND id = ?::bigint AND status = 'ACTIVE' AND deleted_at IS NULL
             AND failing_since <= clock_timestamp() - make_interval(secs => ?::integer)
           RETURNING public_id::text AS public_id, version`,
          [endpointId, afterSec],
        ),
      );
    return r ? { publicId: r.public_id, version: r.version } : undefined;
  }
```
(`markFailing` dùng `WHERE failing_since IS NULL` thay cho `COALESCE` của spec: cùng nghĩa, nhưng chỉ khoá dòng ở lần lỗi đầu, nên 20 lỗi song song không xếp hàng trên dòng endpoint vì một UPDATE không đổi gì.)

- [ ] **Step 4: Handler gửi và policy**

`src/modules/integrations/application/webhooks-out-policy.ts`:
```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { ResiliencePolicies } from '../../../core/resilience/index.js';
import { WEBHOOKS_OUT, WEBHOOK_BREAKER_NEVER } from '../constants.js';
import { integrationsConfig } from '../integrations.config.js';

/**
 * Spec SP6 §5.3 hàng `core/resilience`, S6-A30: breaker theo provider sẽ gộp endpoint của mọi khách, nên tắt hẳn (ngưỡng không
 * bao giờ đạt); sức khoẻ theo endpoint nằm ở DB. Retry do lịch của delivery đảm nhận (POST vốn không được `HttpClient`
 * retry). Gọi lúc DI (`onModuleInit`), trước lời gọi đầu tiên tới provider (hợp đồng `setProviderDefaults`). Chỉ worker.
 */
@Injectable()
export class WebhooksOutPolicy implements OnModuleInit {
  constructor(
    private readonly policies: ResiliencePolicies,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}
  onModuleInit(): void {
    this.policies.setProviderDefaults(WEBHOOKS_OUT, {
      retries: 0,
      timeoutMs: this.cfg.webhookTimeoutMs,
      breakerThreshold: WEBHOOK_BREAKER_NEVER,
      bulkheadLimit: this.cfg.bulkheadLimit,
      bulkheadQueue: this.cfg.bulkheadQueue,
    });
  }
}
```
`src/modules/integrations/application/deliver-webhook.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { appConfig, type ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { KillSwitches } from '../../../core/flags/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { HttpClient } from '../../../core/resilience/index.js';
import { FieldCipherError } from '../../../core/security/index.js';
import { CLAIM_CLOCK_SKEW_MS, DELIVERY_AGGREGATE, ENDPOINT_AGGREGATE, INTEGRATIONS_SYSTEM_ACTOR, WEBHOOKS_OUT, WEBHOOK_USER_AGENT_SUFFIX } from '../constants.js';
import { outcomeOfError, outcomeOfStatus, type AttemptOutcome } from '../domain/attempt-outcome.js';
import { jitteredMs, retryDelayMs, scheduledDelaySec } from '../domain/retry-schedule.js';
import { classifyAttempt, type AttemptError } from '../domain/webhook-delivery.js';
import { DeliveryExhaustedEvent, EndpointDisabledEvent } from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import { DeliverWebhookJob, busyJobId, deliveryJobId, killedJobId } from '../jobs.js';
import { WebhookDeliveryKillSwitch } from '../kill-switches.js';
import { DeliveryRepository, type ClaimedDelivery, type DeliveryResult } from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';
import { WebhookSigner } from '../ports/webhook-signer.js';
import { IntegrationsMetrics } from './integrations-metrics.js';
import { LocalFailures } from './local-failures.js';
import { WebhookSecrets } from './webhook-secrets.js';

const MS_PER_SEC = 1000;
export type DeliverResult = 'killed' | 'busy' | 'skipped' | 'cancelled' | 'succeeded' | 'retry_scheduled' | 'exhausted' | 'local_fault' | 'fenced';
type Send = {
  claim: ClaimedDelivery;
  endpointPublicId: string;
  url: string;
  eventId: string;
  eventType: string;
  body: string;
  secrets: string[];
};
type Recorded = { result: DeliverResult; error?: AttemptError; autoDisabled: boolean };
/** `BUSY`: endpoint đã đủ in-flight (R-X35). `RECORDED`: kết quả đã ghi ngay trong transaction claim (secret không giải mã được). */
type Claim = { kind: 'SKIPPED' } | { kind: 'CANCELLED' } | { kind: 'BUSY' } | { kind: 'RECORDED'; recorded: Recorded } | ({ kind: 'SEND' } & Send);
type JobIdOf = (publicId: string, attempt: number, atMs: number) => string;

/**
 * Spec SP6 §8.3 "Gửi": claim (transaction) → ký + HTTP (ngoài transaction) → ghi kết quả (transaction, CAS có fencing).
 * Hai transaction đều chạy lại được (`UnitOfWork` retry 40001/40P01): không I/O ngoài bên trong, mọi ghi là CAS.
 * WorkerHost đã mở OrgScope theo `meta.orgId`; `onInactiveOrg: 'run'` (org xoá mềm vẫn nhận `tenancy.org.deleted`).
 */
@Injectable()
@JobHandler(DeliverWebhookJob)
export class DeliverWebhookHandler {
  private readonly logger = new Logger(DeliverWebhookHandler.name);
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly secrets: WebhookSecrets,
    private readonly signer: WebhookSigner,
    private readonly http: HttpClient,
    private readonly killSwitches: KillSwitches,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    private readonly metrics: IntegrationsMetrics,
    private readonly localFailures: LocalFailures,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  async handle(ctx: JobContext<{ deliveryId: string }>): Promise<void> {
    const r = await integrationsSpan(
      'integrations.deliver',
      () => this.run(ctx.payload.deliveryId, ctx.signal),
      (x) => ({ 'webhook.result': x.result, ...(x.error ? { 'webhook.error': x.error } : {}) }),
    );
    this.metrics.deliveries.add(1, { result: r.result });
    if (r.error && classifyAttempt(r.error) === 'LOCAL') this.metrics.localFaults.add(1, { reason: r.error.toLowerCase() });
    if (r.result === 'exhausted') this.metrics.exhausted.add(1);
    if (r.autoDisabled) this.metrics.autoDisabled.add(1);
  }

  private async run(deliveryId: string, signal: AbortSignal): Promise<Recorded> {
    if (await this.killSwitches.isKilled(WebhookDeliveryKillSwitch.key)) {
      await this.uow.run(() => this.defer(deliveryId, this.cfg.killedRecheckSec * MS_PER_SEC, killedJobId));
      return { result: 'killed', autoDisabled: false };
    }
    const claim = await this.uow.run(() => this.claim(deliveryId));
    switch (claim.kind) {
      case 'SKIPPED':
        return { result: 'skipped', autoDisabled: false };
      case 'CANCELLED':
        return { result: 'cancelled', autoDisabled: false };
      case 'BUSY':
        return { result: 'busy', autoDisabled: false };
      case 'RECORDED':
        return claim.recorded;
      case 'SEND':
        break;
      default: {
        const unreachable: never = claim;
        throw new Error(`Unhandled claim ${JSON.stringify(unreachable)}`);
      }
    }
    // Worker đang tắt sau khi claim: lease hết hạn → sweep lấy lại (LEASE_EXPIRED, lỗi của ta), không mất delivery.
    signal.throwIfAborted();
    const outcome = await this.send(claim);
    const recorded = await this.uow.run(() => this.record(claim, outcome));
    if (outcome.kind === 'DELIVERED' && recorded.result === 'succeeded')
      this.metrics.lag.record((Date.now() - claim.claim.createdAtMs) / MS_PER_SEC);
    return recorded;
  }

  /**
   * Sự kiện `DEFER` (kill switch, endpoint đủ in-flight): dời lần hẹn, không claim, không đếm. Job mới có hậu tố riêng vì job
   * `a<n>` đang chạy còn trong Redis (BullMQ bỏ qua `add` trùng id). Không dời (chưa đến hạn) → không enqueue.
   */
  private async defer(deliveryId: string, delayMs: number, jobIdOf: JobIdOf): Promise<boolean> {
    const attempts = await this.deliveries.defer(deliveryId, delayMs, CLAIM_CLOCK_SKEW_MS);
    if (attempts === undefined) return false;
    await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId }, { jobId: jobIdOf(deliveryId, attempts + 1, Date.now()), delayMs });
    return true;
  }

  private async claim(deliveryId: string): Promise<Claim> {
    const endpointId = await this.deliveries.dueEndpointOf(deliveryId, CLAIM_CLOCK_SKEW_MS);
    if (endpointId === undefined) return { kind: 'SKIPPED' };
    // R-X35: endpoint chết không giữ quá N slot của bulkhead `webhooks-out` chung. Khoá endpoint TRƯỚC delivery (thứ tự khoá ở
    // Global Constraints); từ chối = DEFER, không tăng attempts_total, không đếm vào local_failures.
    const inflight = await this.endpoints.lockForClaim(endpointId);
    if (inflight !== undefined && inflight >= this.cfg.maxInflightPerEndpoint)
      return (await this.defer(deliveryId, jitteredMs(this.cfg.localFaultRetrySec, Math.random), busyJobId)) ? { kind: 'BUSY' } : { kind: 'SKIPPED' };
    const d = await this.deliveries.claim(deliveryId, this.cfg.deliveryLeaseMs, CLAIM_CLOCK_SKEW_MS);
    if (!d) return { kind: 'SKIPPED' };
    const endpoint = await this.endpoints.forSend(d.endpointId);
    // R6-10, R6-25: endpoint tắt hoặc xoá sau khi delivery được tạo → huỷ ngay lúc claim, không gửi.
    if (!endpoint || endpoint.status !== 'ACTIVE' || endpoint.deleted) {
      if (!(await this.deliveries.cancelClaimed(d, d.attemptsTotal))) throw new Error(`delivery ${d.publicId} changed inside its claim transaction`);
      return { kind: 'CANCELLED' };
    }
    const message = await this.deliveries.messageOf(d);
    const orgId = this.orgId();
    // R6-11: secret đọc lúc claim. Không có secret nào là vỡ bất biến (tạo endpoint ghi secret cùng transaction): ném to.
    const sealed = await this.endpoints.signingSecrets(d.endpointId);
    if (sealed.length === 0) throw new Error(`webhook endpoint ${endpoint.publicId} has no signing secret`);
    let secrets: string[];
    try {
      secrets = sealed.map((s) => this.secrets.open(s.secretEnc, { orgId, secretPublicId: s.publicId }));
    } catch (err) {
      if (!(err instanceof FieldCipherError)) throw err;
      // R-X35: kid bị retire sai hay ciphertext hỏng là lỗi của ta. Ghi thành lỗi có đếm NGAY trong transaction claim: ném sẽ
      // rollback claim, BullMQ retry rồi bỏ job, delivery kẹt PENDING không ai hẹn lại (hoặc sweep enqueue lại mãi). Lần thứ
      // INTEGRATIONS_MAX_LOCAL_FAILURES → EXHAUSTED, phát lại được sau khi sửa keyring. Log chỉ mã lỗi, không token.
      this.logger.error(
        { event: 'webhook_secret_unreadable', deliveryId: d.publicId, endpointId: endpoint.publicId, cipherError: err.code },
        'webhook signing secret cannot be decrypted; counted as a local failure',
      );
      return { kind: 'RECORDED', recorded: await this.recordLocal(d, 'SECRET_UNAVAILABLE', null) };
    }
    return { kind: 'SEND', claim: d, endpointPublicId: endpoint.publicId, url: endpoint.url, ...message, secrets };
  }

  private async send(s: Send): Promise<AttemptOutcome> {
    const at = new Date();
    const signature = this.signer.sign({ secrets: s.secrets, messageId: s.eventId, timestamp: at, body: s.body });
    const started = performance.now();
    try {
      const res = await this.http.request(WEBHOOKS_OUT, s.url, {
        method: 'POST',
        body: s.body,
        headers: {
          'content-type': 'application/json',
          'user-agent': `${this.app.serviceName}${WEBHOOK_USER_AGENT_SUFFIX}`,
          'webhook-id': s.eventId,
          'webhook-timestamp': String(Math.floor(at.getTime() / MS_PER_SEC)),
          'webhook-signature': signature,
        },
      });
      return outcomeOfStatus(res.status);
    } catch (err) {
      const outcome = outcomeOfError(err);
      if (outcome.kind === 'FAILED' && outcome.error === 'SSRF_BLOCKED')
        this.logger.warn({ event: 'webhook_ssrf_blocked', deliveryId: s.claim.publicId, endpointId: s.endpointPublicId }, 'webhook destination refused at connect');
      return outcome;
    } finally {
      this.metrics.attemptDuration.record((performance.now() - started) / MS_PER_SEC);
    }
  }

  private async record(s: Send, outcome: AttemptOutcome): Promise<Recorded> {
    const c = s.claim;
    switch (outcome.kind) {
      case 'DELIVERED': {
        if (!(await this.deliveries.finish(c, c.attemptsTotal, { kind: 'SUCCEEDED', statusCode: outcome.statusCode }))) return this.fenced(c);
        await this.endpoints.clearFailing(c.endpointId);
        return { result: 'succeeded', autoDisabled: false };
      }
      case 'FAILED':
        return this.recordFailure(s, outcome);
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled outcome ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async recordFailure(s: Send, o: Extract<AttemptOutcome, { kind: 'FAILED' }>): Promise<Recorded> {
    const c = s.claim;
    const blame = classifyAttempt(o.error);
    switch (blame) {
      case 'LOCAL':
        return this.recordLocal(c, o.error, o.statusCode);
      case 'ENDPOINT': {
        const step = scheduledDelaySec(this.cfg.retryScheduleSec, c.attemptsTotal - c.cycleBase);
        const result: DeliveryResult =
          step === undefined
            ? { kind: 'EXHAUSTED', statusCode: o.statusCode, error: o.error, localBump: 0 }
            : {
                kind: 'RETRY',
                statusCode: o.statusCode,
                error: o.error,
                delayMs: retryDelayMs({ scheduleSec: step, retryAfterSec: o.retryAfterSec, random: Math.random }),
                cycleBump: 0,
                localBump: 0,
              };
        // Fencing trước khi chạm endpoint: kết quả của một lần gửi đã mất lease không được đổi sức khoẻ endpoint.
        if (!(await this.deliveries.finish(c, c.attemptsTotal, result))) return this.fenced(c);
        if (result.kind === 'RETRY') await this.scheduleNext(c.publicId, c.attemptsTotal, result.delayMs);
        else
          await this.events.publish(DeliveryExhaustedEvent, {
            data: { deliveryId: c.publicId, endpointId: s.endpointPublicId, eventType: s.eventType, eventId: s.eventId },
            aggregate: { type: DELIVERY_AGGREGATE, id: c.publicId, version: c.attemptsTotal },
            actor: INTEGRATIONS_SYSTEM_ACTOR,
          });
        await this.endpoints.markFailing(c.endpointId);
        const disabled = await this.endpoints.autoDisable(c.endpointId, this.cfg.endpointDisableAfterSec);
        if (disabled)
          await this.events.publish(EndpointDisabledEvent, {
            data: { endpointId: disabled.publicId, reason: 'AUTO_FAILING' },
            aggregate: { type: ENDPOINT_AGGREGATE, id: disabled.publicId, version: disabled.version },
            actor: INTEGRATIONS_SYSTEM_ACTOR,
          });
        return { result: result.kind === 'RETRY' ? 'retry_scheduled' : 'exhausted', error: o.error, autoDisabled: disabled !== undefined };
      }
      default: {
        const unreachable: never = blame;
        throw new Error(`Unhandled blame ${String(unreachable)}`);
      }
    }
  }

  /** Job của lần thử kế (`a<attempts + 1>` chưa từng được claim), ghi outbox cùng transaction với kết quả. */
  private scheduleNext(deliveryId: string, attempts: number, delayMs: number): Promise<void> {
    return this.enqueue.enqueue(DeliverWebhookJob, { deliveryId }, { jobId: deliveryJobId(deliveryId, attempts + 1), delayMs });
  }

  /** R6-28 + R-X35 qua `LocalFailures` (một luật cho handler và sweep); kết quả fence vẫn log ở đây. */
  private async recordLocal(c: ClaimedDelivery, error: AttemptError, statusCode: number | null): Promise<Recorded> {
    const r = await this.localFailures.record(c, error, statusCode);
    switch (r) {
      case 'fenced':
        return this.fenced(c);
      case 'local_fault':
      case 'exhausted':
        return { result: r, error, autoDisabled: false };
      default: {
        const unreachable: never = r;
        throw new Error(`Unhandled local failure result ${String(unreachable)}`);
      }
    }
  }

  private fenced(c: ClaimedDelivery): Recorded {
    this.logger.warn({ event: 'webhook_result_fenced', deliveryId: c.publicId, attempts: c.attemptsTotal }, 'a newer claim owns this delivery; result dropped');
    return { result: 'fenced', autoDisabled: false };
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined) throw new Error('DeliverWebhookHandler ran without an org context');
    return id;
  }
}
```
`src/modules/integrations/application/local-failures.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { DELIVERY_AGGREGATE, INTEGRATIONS_SYSTEM_ACTOR } from '../constants.js';
import { jitteredMs } from '../domain/retry-schedule.js';
import { classifyAttempt, localRetryLeft, type AttemptError } from '../domain/webhook-delivery.js';
import { DeliveryExhaustedEvent } from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import { DeliveryRepository, type ClaimedDelivery } from '../ports/delivery-repository.js';

export type LocalFailureResult = 'local_fault' | 'exhausted' | 'fenced';

/**
 * Lỗi của ta (spec SP6 §7.2, R6-28, R-X35): không tiêu lịch (`cycle_base + 1`), không chạm endpoint, nhưng có đếm
 * (`local_failures + 1`); lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` + event, phát lại được bằng `retry`/`recover`.
 * Ba nơi gọi (handler gửi: lỗi của `HttpClient` và secret không giải mã được; sweep: lease hết hạn) nên luật nằm một chỗ.
 * Chạy trong transaction của caller: CAS có fencing, job kế qua outbox cùng transaction.
 */
@Injectable()
export class LocalFailures {
  constructor(
    private readonly deliveries: DeliveryRepository,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async record(c: ClaimedDelivery, error: AttemptError, statusCode: number | null): Promise<LocalFailureResult> {
    if (classifyAttempt(error) !== 'LOCAL') throw new Error(`${error} is not a fault on our side`);
    if (localRetryLeft(c.localFailures, this.cfg.maxLocalFailures)) {
      const delayMs = jitteredMs(this.cfg.localFaultRetrySec, Math.random);
      if (!(await this.deliveries.finish(c, c.attemptsTotal, { kind: 'RETRY', statusCode, error, delayMs, cycleBump: 1, localBump: 1 }))) return 'fenced';
      await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId: c.publicId }, { jobId: deliveryJobId(c.publicId, c.attemptsTotal + 1), delayMs });
      return 'local_fault';
    }
    if (!(await this.deliveries.finish(c, c.attemptsTotal, { kind: 'EXHAUSTED', statusCode, error, localBump: 1 }))) return 'fenced';
    const info = await this.deliveries.describe(c);
    await this.events.publish(DeliveryExhaustedEvent, {
      data: { deliveryId: c.publicId, endpointId: info.endpointPublicId, eventType: info.eventType, eventId: info.eventId },
      aggregate: { type: DELIVERY_AGGREGATE, id: c.publicId, version: c.attemptsTotal },
      actor: INTEGRATIONS_SYSTEM_ACTOR,
    });
    return 'exhausted';
  }
}
```
`src/modules/integrations/integrations.module.ts`: `IntegrationsWorkerModule.providers` thêm `WebhooksOutPolicy`, `LocalFailures`, `DeliverWebhookHandler`.

- [ ] **Step 5: Sweep — job bị mất, lease hết hạn (lỗi của ta, có trần), xoá cứng endpoint đến hạn (R-X33, R6C-3, M5)**

`test/integration/integrations/sweep.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { IntegrationsSweepOrgHandler } from '../../../src/modules/integrations/application/sweep.handlers.js';
import { DeliveryRepository } from '../../../src/modules/integrations/ports/delivery-repository.js';
import { EndpointRepository } from '../../../src/modules/integrations/ports/endpoint-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import { deliveryRow } from '../../support/integrations-delivery.js';
import { inOrg, insertDelivery, insertEndpoint, insertMessage, orgQuery, orphanDeliveries } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const GRACE_SEC = 60;
/** `INTEGRATIONS_MAX_LOCAL_FAILURES` mặc định (app test không đặt env này). */
const MAX_LOCAL = 5;
const ctxOf = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});

describe('integrations.sweep-org (spec SP6 §8.3 "Sweep", §7.2, §7.3)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const extra: SeededOrg[] = [];
  const sweepOf = (o: SeededOrg) => app.get(OrgScope).run(o.orgId, () => app.get(IntegrationsSweepOrgHandler).handle(ctxOf(o.orgId)));
  const sweep = () => sweepOf(org);
  const seedDeliveryIn = (o: SeededOrg) =>
    inOrg(o.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, o.orgId);
      const d = await insertDelivery(c, o.orgId, { endpoint, message: await insertMessage(c, o.orgId) });
      return { endpoint, publicId: d.publicId };
    });
  const seedDelivery = () => seedDeliveryIn(org);
  const freshOrg = async () => {
    const o = await seedOrg();
    extra.push(o);
    return o;
  };
  beforeAll(async () => {
    app = await createTestApp(integrationsCoreImports(), {});
    org = await seedOrg();
  });
  afterAll(async () => {
    for (const o of extra) await o.dispose();
    await org?.dispose();
    await app?.close();
  });

  it('a PENDING delivery overdue by more than the grace gets a new job (lost job); a fresh one does not', async () => {
    const overdue = await seedDelivery();
    const fresh = await seedDelivery();
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() - make_interval(secs => $2) WHERE public_id = $1`, [
      overdue.publicId,
      GRACE_SEC * 2,
    ]);
    expect((await sweep()).requeued).toBeGreaterThanOrEqual(1);
    const jobs = await ownerQuery<{ payload: { jobId: string; payload: { deliveryId: string } } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->>'job' = 'integrations.deliver-webhook'`,
      [org.orgId],
    );
    const forIds = jobs.map((j) => j.payload.payload.deliveryId);
    expect(forIds).toContain(overdue.publicId);
    expect(forIds).not.toContain(fresh.publicId);
    expect(jobs.find((j) => j.payload.payload.deliveryId === overdue.publicId)?.payload.jobId).toMatch(new RegExp(`^webhook-${overdue.publicId}-a1-s\\d+$`));
  });
  it('M5: takeOverdue caps one pass and touches what it took, so the next pass takes the rest — no starvation, no duplicate jobs', async () => {
    const o = await freshOrg();
    const ids = [(await seedDeliveryIn(o)).publicId, (await seedDeliveryIn(o)).publicId, (await seedDeliveryIn(o)).publicId];
    await orgQuery(o.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() - make_interval(secs => $1)`, [GRACE_SEC * 2]);
    const take = () =>
      app.get(OrgScope).run(o.orgId, () => app.get(UnitOfWork).run(() => app.get(DeliveryRepository).takeOverdue(GRACE_SEC, 2)));
    const first = await take();
    const second = await take();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((d) => d.publicId))).toEqual(new Set(ids));
    expect(await take()).toEqual([]);
  });
  it('W-34 (lease part): an expired lease is our fault — RETRY_SCHEDULED with LEASE_EXPIRED, cycle_base + 1, local_failures + 1, endpoint untouched, job a<n+1>', async () => {
    const d = await seedDelivery();
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 3, cycle_base = 1,
         lease_until = now() - make_interval(secs => $2) WHERE public_id = $1`,
      [d.publicId, GRACE_SEC * 2],
    );
    expect((await sweep()).leases).toBe(1);
    expect(await deliveryRow(org.orgId, d.publicId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'LEASE_EXPIRED',
      attempts_total: 3,
      cycle_base: 2,
      local_failures: 1,
    });
    const [ep] = await orgQuery<{ failing_since: Date | null; status: string }>(org.orgId, `SELECT failing_since, status FROM webhook_endpoints WHERE id = $1`, [
      d.endpoint.id,
    ]);
    expect(ep).toEqual({ failing_since: null, status: 'ACTIVE' });
    const [job] = await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2`,
      [org.orgId, d.publicId],
    );
    expect(job?.payload.jobId).toBe(`webhook-${d.publicId}-a4`);
  });
  it(`R-X35: a lease that expires ${MAX_LOCAL} times exhausts the delivery (recoverable) with one exhausted event; the endpoint stays healthy`, async () => {
    const o = await freshOrg();
    const d = await seedDeliveryIn(o);
    for (let i = 1; i <= MAX_LOCAL; i++) {
      // Mô phỏng một claim nữa rồi worker chết: attempts_total + 1, SENDING, lease đã quá hạn + grace.
      await orgQuery(
        o.orgId,
        `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = attempts_total + 1,
           lease_until = now() - make_interval(secs => $2) WHERE public_id = $1`,
        [d.publicId, GRACE_SEC * 2],
      );
      const r = await sweepOf(o);
      expect(r).toMatchObject({ leases: 1, exhausted: i < MAX_LOCAL ? 0 : 1 });
      expect(await deliveryRow(o.orgId, d.publicId)).toMatchObject({
        status: i < MAX_LOCAL ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
        last_error: 'LEASE_EXPIRED',
        local_failures: i,
        lease_until: null,
      });
    }
    const exhausted = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`,
      [o.orgId, d.publicId],
    );
    expect(exhausted.map((e) => e.payload)).toEqual([
      { deliveryId: d.publicId, endpointId: d.endpoint.publicId, eventType: 'tenancy.org.updated', eventId: expect.any(String) },
    ]);
    const [ep] = await orgQuery<{ failing_since: Date | null; status: string }>(o.orgId, `SELECT failing_since, status FROM webhook_endpoints WHERE id = $1`, [
      d.endpoint.id,
    ]);
    expect(ep).toEqual({ failing_since: null, status: 'ACTIVE' });
  });
  it('§7.3: a soft-deleted endpoint due for purge is hard-deleted with its secrets and subscriptions; one with deliveries is postponed; no orphan delivery (R6C-3, R-X33)', async () => {
    const empty = await inOrg(org.orgId, (c) => insertEndpoint(c, org.orgId));
    const busy = await seedDelivery();
    for (const id of [empty.id, busy.endpoint.id])
      await orgQuery(org.orgId, `UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [id]);
    expect(await sweep()).toMatchObject({ purged: 1, postponed: 1 });
    expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_endpoints WHERE id = $1`, [empty.id])).toEqual([]);
    expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_endpoint_event_types WHERE endpoint_id = $1`, [empty.id])).toEqual([]);
    const [kept] = await orgQuery<{ later: boolean }>(
      org.orgId,
      `SELECT purge_after > now() + interval '61 days' AS later FROM webhook_endpoints WHERE id = $1`,
      [busy.endpoint.id],
    );
    expect(kept?.later).toBe(true);
    expect(await orphanDeliveries(org.orgId)).toBe(0);
  });
  it('R-X33 / R6C-3: while a fan-out holds FOR KEY SHARE on an endpoint the sweep skips it; after the fan-out commits the endpoint is postponed, never deleted under its delivery', async () => {
    const o = await freshOrg();
    const e = await inOrg(o.orgId, (c) => insertEndpoint(c, o.orgId));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let holding!: () => void;
    const held = new Promise<void>((r) => {
      holding = r;
    });
    // Đúng các bước ghi của fan-out (Task 10) trong một transaction, dừng trước commit.
    const fanout = app.get(OrgScope).run(o.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        const ids = await app.get(EndpointRepository).activeSubscribers('tenancy.org.updated');
        expect(ids).toEqual([e.id]);
        const message = await app.get(DeliveryRepository).insertMessage({ eventId: v7(), eventType: 'tenancy.org.updated', eventVersion: 1, body: '{}' });
        await app.get(DeliveryRepository).insertDeliveries(message, ids);
        holding();
        await gate;
      }),
    );
    await held;
    // Xoá mềm đến hạn purge (UPDATE không đổi khoá: FOR NO KEY UPDATE, không xung đột với FOR KEY SHARE của fan-out).
    await orgQuery(o.orgId, `UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [e.id]);
    expect(await sweepOf(o)).toMatchObject({ purged: 0, postponed: 0 });
    release();
    await fanout;
    expect(await sweepOf(o)).toMatchObject({ purged: 0, postponed: 1 });
    expect(await orphanDeliveries(o.orgId)).toBe(0);
  });
  it('running the sweep twice in a row is idempotent (claims are SKIP LOCKED CAS; a second pass finds nothing new to fix)', async () => {
    const r = await sweep();
    expect(r.leases).toBe(0);
    expect(r.purged).toBe(0);
  });
});
```
(Ca R-X33 dùng hai promise làm cửa: transaction "fan-out" thật sự đang mở và giữ khoá khi sweep chạy — ép xen kẽ, không sleep. RED: tạm bỏ `FOR KEY SHARE OF e` khỏi `activeSubscribers` → lượt sweep đầu xoá cứng endpoint (`purged: 1`), `orphanDeliveries` = 1 sau commit; hoàn nguyên, ghi vào báo cáo task.)

`src/modules/integrations/ports/delivery-repository.ts`: thêm
```ts
  /**
   * Tối đa `limit` delivery `PENDING | RETRY_SCHEDULED` quá hạn hơn `graceSec` (job bị mất), khoá `FOR UPDATE SKIP LOCKED`, và
   * "chạm" `next_attempt_at = now` (M5): lượt sau trong cửa sổ grace lấy phần còn lại thay vì lấy lại đúng các dòng này.
   */
  abstract takeOverdue(graceSec: number, limit: number): Promise<{ publicId: string; attemptsTotal: number }[]>;
  /** `SENDING` có `lease_until` quá `graceSec`; khoá `FOR UPDATE SKIP LOCKED`. */
  abstract expiredLeases(graceSec: number, limit: number): Promise<ClaimedDelivery[]>;
```
`src/modules/integrations/infra/sql/sql-delivery.repository.ts`: thêm
```ts
  async takeOverdue(graceSec: number, limit: number): Promise<{ publicId: string; attemptsTotal: number }[]> {
    return z
      .array(z.object({ public_id: z.uuid(), attempts_total: z.number().int() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_deliveries AS d SET next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
           FROM (SELECT id, created_at FROM webhook_deliveries
                 WHERE org_id = app_current_org() AND status IN ('PENDING', 'RETRY_SCHEDULED')
                   AND next_attempt_at <= clock_timestamp() - make_interval(secs => ?::integer)
                 ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED) AS o
           WHERE d.org_id = app_current_org() AND d.id = o.id AND d.created_at = o.created_at
           RETURNING d.public_id::text AS public_id, d.attempts_total`,
          [graceSec, limit],
        ),
      )
      .map((r) => ({ publicId: r.public_id, attemptsTotal: r.attempts_total }));
  }
  async expiredLeases(graceSec: number, limit: number): Promise<ClaimedDelivery[]> {
    return ClaimRow.parse(
      await this.db.execute(
        `SELECT d.id::text AS id, d.public_id::text AS public_id, ${CREATED_AT_KEY_SQL('d')} AS created_at,
           (extract(epoch FROM d.created_at) * 1000)::float8 AS created_at_ms, d.endpoint_id::text AS endpoint_id,
           d.message_id::text AS message_id, d.attempts_total, d.cycle_base, d.local_failures
         FROM webhook_deliveries d
         WHERE d.org_id = app_current_org() AND d.status = 'SENDING' AND d.lease_until <= clock_timestamp() - make_interval(secs => ?::integer)
         ORDER BY d.lease_until LIMIT ? FOR UPDATE SKIP LOCKED`,
        [graceSec, limit],
      ),
    ).map(toClaimed);
  }
```
`src/modules/integrations/ports/endpoint-repository.ts`: thêm
```ts
  /**
   * Xoá cứng endpoint đã xoá mềm tới hạn `purge_after` mà không còn delivery (secret, đăng ký đi theo `CASCADE`); còn
   * delivery (partition chưa hết retention) → dời `purge_after` thêm `postponeSec` (spec §7.3). Không có FK delivery →
   * endpoint (R-X33): khoá `FOR UPDATE` dòng endpoint (xung đột với `FOR KEY SHARE` của fan-out) rồi kiểm `NOT EXISTS`.
   */
  abstract purgeDue(limit: number, postponeSec: number): Promise<{ deleted: number; postponed: number }>;
```
`src/modules/integrations/infra/sql/sql-endpoint.repository.ts`: thêm
```ts
  async purgeDue(limit: number, postponeSec: number): Promise<{ deleted: number; postponed: number }> {
    const IdRows = z.array(z.object({ id: z.string() }));
    // 1) Khoá; dòng đang bị người ghi delivery giữ (FOR KEY SHARE) thì bỏ qua tới lượt sau.
    const locked = IdRows.parse(
      await this.db.execute(
        `SELECT e.id::text AS id FROM webhook_endpoints e
         WHERE e.org_id = app_current_org() AND e.deleted_at IS NOT NULL AND e.purge_after <= clock_timestamp()
         ORDER BY e.purge_after LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      ),
    ).map((r) => r.id);
    if (locked.length === 0) return { deleted: 0, postponed: 0 };
    // 2) Câu RIÊNG sau khi có khoá: snapshot mới của READ COMMITTED thấy mọi delivery mà người ghi vừa nhả khoá đã commit.
    // Gộp `EXISTS` vào câu khoá thì subquery dùng snapshot đầu câu và có thể bỏ sót delivery commit trong lúc chờ.
    const deleted = IdRows.parse(
      await this.db.execute(
        `DELETE FROM webhook_endpoints e WHERE e.org_id = app_current_org() AND e.id = ANY(ARRAY[?]::bigint[])
           AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.org_id = e.org_id AND d.endpoint_id = e.id)
         RETURNING e.id::text AS id`,
        [locked],
      ),
    ).map((r) => r.id);
    const kept = locked.filter((id) => !deleted.includes(id));
    if (kept.length > 0)
      await this.db.execute(
        `UPDATE webhook_endpoints SET purge_after = clock_timestamp() + make_interval(secs => ?::integer), updated_at = clock_timestamp()
         WHERE org_id = app_current_org() AND id = ANY(ARRAY[?]::bigint[])`,
        [postponeSec, kept],
      );
    return { deleted: deleted.length, postponed: kept.length };
  }
```
(R6C-3: endpoint đã xoá mềm không nhận delivery mới — fan-out chỉ chọn `deleted_at IS NULL` dưới `FOR KEY SHARE`, retry/recover/test trả 404 cho endpoint đã xoá dưới `FOR SHARE` — và người xoá duy nhất (sweep) kiểm `NOT EXISTS` sau khi đã giữ `FOR UPDATE`, nên không có delivery mồ côi. Không còn FK làm lưới an toàn (R-X33): lưới là test bất biến `orphanDeliveries` ở Task 3, ở ca trên và ở purge Task 15.)

`src/modules/integrations/application/sweep.handlers.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { OrgSweepRunner, type OrgSweepResult } from '../../../core/sweep/index.js';
import { integrationsConfig } from '../integrations.config.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import { DeliverWebhookJob, IntegrationsSweep, IntegrationsSweepOrgJob, sweptJobId } from '../jobs.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';
import { IntegrationsMetrics } from './integrations-metrics.js';
import { LocalFailures } from './local-failures.js';

const MS_PER_SEC = 1000;

/** Cron `integrations.sweep-orgs` (queue `maintenance`): một handler mỏng, runner của core làm vòng lặp (R-X4). */
@Injectable()
@JobHandler(IntegrationsSweep.job)
export class IntegrationsSweepHandler {
  constructor(private readonly runner: OrgSweepRunner) {}
  handle(): Promise<OrgSweepResult> {
    return this.runner.run(IntegrationsSweep);
  }
}

export type SweepOrgResult = { requeued: number; leases: number; exhausted: number; purged: number; postponed: number };

/**
 * Việc theo org (spec SP6 §8.3 "Sweep"; queue `webhooks-out`, `onInactiveOrg: 'run'` — I4). Một transaction, mọi claim là
 * `FOR UPDATE SKIP LOCKED` nên hai lượt song song không làm cùng một dòng; job enqueue qua outbox cùng transaction. Mỗi loại
 * việc tối đa `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG` dòng mỗi lượt (M5).
 */
@Injectable()
@JobHandler(IntegrationsSweepOrgJob)
export class IntegrationsSweepOrgHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly enqueue: SafeEnqueue,
    private readonly localFailures: LocalFailures,
    private readonly metrics: IntegrationsMetrics,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async handle(_ctx?: JobContext<unknown>): Promise<SweepOrgResult> {
    const r = await integrationsSpan('integrations.sweep.org', () => this.uow.run(() => this.sweep()));
    // Ngoài transaction: lần chạy lại của `UnitOfWork` (40001/40P01) không đếm hai lần.
    if (r.leases > 0) this.metrics.localFaults.add(r.leases, { reason: 'lease_expired' });
    if (r.exhausted > 0) this.metrics.exhausted.add(r.exhausted);
    return r;
  }

  private async sweep(): Promise<SweepOrgResult> {
    const grace = this.cfg.sweepGraceSec;
    const limit = this.cfg.sweepRequeueMaxPerOrg;
    // Một job mỗi cửa sổ grace: lượt sau trong cùng cửa sổ không tạo job trùng, job đã hoàn tất cùng id không nuốt job mới.
    const slot = Math.floor(Date.now() / MS_PER_SEC / grace);
    const overdue = await this.deliveries.takeOverdue(grace, limit);
    for (const d of overdue)
      await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId: d.publicId }, { jobId: sweptJobId(d.publicId, d.attemptsTotal + 1, slot) });
    const leases = await this.deliveries.expiredLeases(grace, limit);
    let exhausted = 0;
    // Lỗi của ta (§7.2, R-X35): không tiêu lịch, không chạm endpoint, có đếm; CAS có fencing như mọi kết quả.
    for (const d of leases) if ((await this.localFailures.record(d, 'LEASE_EXPIRED', null)) === 'exhausted') exhausted++;
    const { deleted, postponed } = await this.endpoints.purgeDue(limit, this.cfg.endpointPurgeDelaySec);
    return { requeued: overdue.length, leases: leases.length, exhausted, purged: deleted, postponed };
  }
}
```
`src/modules/integrations/integrations.module.ts`: `IntegrationsWorkerModule.providers` thêm `IntegrationsSweepHandler`, `IntegrationsSweepOrgHandler`. Từ đây mọi job của queue `webhooks-out` (`integrations.deliver-webhook`, `integrations.sweep-org`) và job cron của `maintenance` (`integrations.sweep-orgs`) đều có `@JobHandler`.

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm vitest run --project integration test/e2e/integrations test/integration/integrations/sweep.spec.ts test/integration/integrations/fanout.spec.ts test/integration/core/sweep
pnpm typecheck && pnpm arch
```
Expected: PASS. Ca W-10/W-11 thấy đúng ba job `a2…a4` và một event `exhausted`; ca W-34 thấy `MAX - 1` lần `BULKHEAD_FULL` với `attempts_total - cycle_base = 0`, lần thứ `MAX` là `EXHAUSTED`, endpoint vẫn `ACTIVE`, `failing_since` `NULL`; ca secret hỏng thấy `SECRET_UNAVAILABLE` ×`MAX`, không request nào ra ngoài; ca in-flight thấy đúng 4 `SENDING`, 6 bị dời với `attempts_total = 0`; `webhook-flow.e2e.spec.ts` thấy receiver nhận và verify được, và sweep-org chạy cho org đã xoá mềm; `org-sweep-signatures.spec.ts` (6.0) chạy trên sweep thật: `integrations_orgs_due` đúng một overload, `p_after uuid`, `p_limit integer`, `p_grace_sec integer`, `sweep_definer`, `EXECUTE` chỉ `app_user`.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/support/webhook-receiver.ts test/support/integrations-delivery.ts test/e2e/integrations test/integration/integrations/sweep.spec.ts
git add src/modules/integrations test/support/webhook-receiver.ts test/support/integrations-delivery.ts test/e2e/integrations test/integration/integrations/sweep.spec.ts
git commit -m "feat(integrations): deliver webhooks with a leased claim, per-endpoint in-flight cap, multi-secret signatures, fenced result CAS, retry schedule, capped local faults, kill switch, webhooks-out policy; sweep lost jobs, expired leases and due endpoint deletes"
```

---

### Task 12: Sức khoẻ endpoint và fencing dưới đua — tự tắt đúng một lần (R6-12, W-32), kết quả cũ bị fence (R6-9, W-31), xoay secret giữa lúc gửi (R6-11)

**Files:**
- Create: `test/support/integrations-races.ts`, `test/e2e/integrations/deliver-races.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 11 (`runDeliver`, `seedPendingDelivery`, `deliveryRow`, `receiverEnv`, `startWebhookReceiver` với `hold()/release()`); `ownerQuery`, `withAppClient`, `inOrgTx`; mẫu barrier của `test/support/org-lock-barrier.ts` (`pg_blocking_pids` bắc cầu); `Webhook` (`standardwebhooks`); `EndpointService` (Task 9).
- Produces: `raceOnRowLock<T>(orgId, lockSql, params, waiters, fire): Promise<T>` (giữ khoá một dòng tenant trên kết nối riêng tới khi đúng `waiters` backend xếp hàng sau nó, rồi COMMIT); bằng chứng R6-9, R6-11, R6-12.

- [ ] **Step 1: Seam**

`test/support/integrations-races.ts`:
```ts
import { ownerQuery } from './identity-app.js';
import { withAppClient } from './tenancy-seed.js';

const POLL_MS = 20;
/** Dưới `idle_in_transaction_session_timeout` của DB test (10 s). */
const DEADLINE_MS = 8_000;

/**
 * Mẫu `raceOnOrgLock` (`org-lock-barrier.ts`) cho một dòng tenant bất kỳ: giữ khoá bằng `lockSql` (vd. `SELECT 1 FROM
 * webhook_endpoints WHERE id = $1 FOR UPDATE`) trong OrgScope trên kết nối riêng, gọi `fire`, chờ tới khi đúng `waiters`
 * backend bị kết nối đó chặn (trực tiếp hoặc bắc cầu qua hàng chờ, `pg_blocking_pids`), rồi COMMIT để thả tất cả cùng lúc.
 * Ép xen kẽ tất định, không dựa vào may rủi của ×N.
 */
export async function raceOnRowLock<T>(orgId: string, lockSql: string, params: unknown[], waiters: number, fire: () => Promise<T>): Promise<T> {
  return withAppClient(async (holder) => {
    await holder.query('BEGIN');
    let pending: Promise<T> | undefined;
    try {
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const locked = await holder.query(lockSql, params);
      if (locked.rowCount !== 1) throw new Error(`raceOnRowLock: lock query matched ${locked.rowCount} rows`);
      const [{ pid } = { pid: -1 }] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      pending = fire();
      pending.catch(() => undefined); // lỗi được ném lại khi await bên dưới
      const until = Date.now() + DEADLINE_MS;
      for (;;) {
        const [row] = await ownerQuery<{ n: number }>(
          `WITH RECURSIVE queued(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid)))
           SELECT count(*)::int AS n FROM queued`,
          [pid],
        );
        if ((row?.n ?? 0) >= waiters) break;
        if (Date.now() > until) throw new Error(`barrier: ${row?.n ?? 0} of ${waiters} transactions queued on the row lock`);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK');
      throw err;
    }
    return pending;
  });
}
```

- [ ] **Step 2: Test (fail trước Task 11; viết sau Task 11 thì PASS ngay — ghi RED bằng cách đảo CAS, xem Step 3)**

`test/e2e/integrations/deliver-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { deliveryRow, receiverEnv, runDeliver, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { raceOnRowLock } from '../../support/integrations-races.js';
import { inOrg, insertDelivery, insertMessage, orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

const FAILURES = 20;

describe('delivery races (spec SP6 §13 R6-9, R6-11, R6-12; W-31, W-32)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        ...receiverEnv(receiver),
        INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
        INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
        INTEGRATIONS_WEBHOOK_TIMEOUT_MS: '10000',
        INTEGRATIONS_DELIVERY_LEASE_MS: '60000',
        // R6-12 cần FAILURES request cùng in-flight trên một endpoint: nâng trần in-flight (R-X35) trên FAILURES; luật config
        // đòi trần < bulkhead và bulkhead ≥ concurrency của queue io.
        INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT: String(FAILURES),
        INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT: String(2 * FAILURES),
        // I3: FAILURES transaction ghi kết quả cùng chờ khoá dòng endpoint, mỗi cái giữ một kết nối của pool; claim của chính các
        // lần gửi đó cũng xếp hàng trên dòng endpoint lúc bắt đầu. DB_POOL_MAX mặc định 10 (`database.config.ts`) sẽ để phần
        // còn lại chờ kết nối thay vì chờ khoá — barrier không bao giờ thấy đủ FAILURES. 2 × FAILURES + 2: cả hai đợt + dư cho
        // relay/worker của app.
        DB_POOL_MAX: String(2 * FAILURES + 2),
      },
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  beforeEach(() => {
    receiver.requests.length = 0;
  });
  afterAll(async () => {
    receiver?.release();
    await org?.dispose();
    await app?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it(`R6-12 / W-32: ${FAILURES} failures past the threshold, all queued on the endpoint row, disable it exactly once`, async () => {
    const first = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const ids = [first.deliveryId];
    await inOrg(org.orgId, async (c) => {
      for (let i = 1; i < FAILURES; i++) ids.push((await insertDelivery(c, org.orgId, { endpoint: first.endpoint, message: await insertMessage(c, org.orgId) })).publicId);
      await c.query(`UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE id = $1`, [first.endpoint.id]);
    });
    receiver.respondWith(...Array.from({ length: FAILURES }, () => ({ status: 500 })));
    // Claim nay khoá dòng endpoint (R-X35), nên barrier phải đặt SAU claim: giữ mọi request ở receiver tới khi đủ FAILURES đã
    // claim và đang bay, rồi mới khoá dòng endpoint và thả receiver — mọi lần ghi kết quả (CAS tự tắt) xếp hàng sau khoá đó và
    // được thả cùng lúc.
    receiver.hold();
    const all = Promise.all(ids.map((id) => runDeliver(app, org.orgId, id)));
    all.catch(() => undefined);
    await receiver.waitFor(FAILURES);
    await raceOnRowLock(org.orgId, `SELECT 1 FROM webhook_endpoints WHERE id = $1 FOR UPDATE`, [first.endpoint.id], FAILURES, async () => {
      receiver.release();
      return all;
    });
    const disabled = await ownerQuery(
      `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'integrations.endpoint.disabled' AND payload->>'endpointId' = $2`,
      [org.orgId, first.endpoint.publicId],
    );
    expect(disabled).toHaveLength(1);
    const [ep] = await orgQuery<{ status: string; disabled_reason: string }>(org.orgId, `SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1`, [
      first.endpoint.id,
    ]);
    expect(ep).toEqual({ status: 'DISABLED', disabled_reason: 'AUTO_FAILING' });
  });
  it('R6-9 / W-31: a worker whose lease was taken over writes 0 rows; the new claim owns the delivery', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.hold();
    const stale = runDeliver(app, org.orgId, d.deliveryId);
    await receiver.waitFor(1);
    // Lease hết hạn khi worker A còn treo; sweep (Task 11 Step 5) làm CAS LEASE_EXPIRED, mô phỏng đúng câu đó ở đây.
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = 'RETRY_SCHEDULED', lease_until = NULL, next_attempt_at = now(), cycle_base = cycle_base + 1, last_error = 'LEASE_EXPIRED'
       WHERE public_id = $1 AND status = 'SENDING'`,
      [d.deliveryId],
    );
    receiver.release();
    await stale;
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'LEASE_EXPIRED', attempts_total: 1 });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'SUCCEEDED', attempts_total: 2 });
  });
  it('R6-11: a rotation while a request is in flight; that request carries the old secret, the next carries both', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.respondWith({ status: 500 });
    receiver.hold();
    const inflight = runDeliver(app, org.orgId, d.deliveryId);
    await receiver.waitFor(1);
    const res = await authed(app, owner).post(`/v1/orgs/${org.orgId}/webhook-endpoints/${d.endpoint.publicId}/rotate-secret`).send();
    expect(res.status).toBe(200);
    const rotated = String(res.body.secret);
    receiver.release();
    await inflight;
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1`, [d.deliveryId]);
    await runDeliver(app, org.orgId, d.deliveryId);
    const [firstReq, secondReq] = await receiver.waitFor(2);
    const verify = (s: string, r: typeof firstReq) =>
      new Webhook(s).verify(r?.body ?? '', {
        'webhook-id': String(r?.headers['webhook-id']),
        'webhook-timestamp': String(r?.headers['webhook-timestamp']),
        'webhook-signature': String(r?.headers['webhook-signature']),
      });
    expect(() => verify(d.secret, firstReq)).not.toThrow();
    expect(() => verify(rotated, firstReq)).toThrow();
    expect(String(secondReq?.headers['webhook-signature']).split(' ')).toHaveLength(2);
    for (const s of [d.secret, rotated]) expect(() => verify(s, secondReq)).not.toThrow();
  });
});
```
(Ca R6-11 xoay qua route thật: `userActor` của event cần principal user của request.)

- [ ] **Step 3: Chạy, ghi RED**

Run: `pnpm vitest run --project integration test/e2e/integrations/deliver-races.e2e.spec.ts`
Expected: PASS. RED của R6-12: tạm bỏ `AND status = 'ACTIVE'` khỏi `autoDisable` → ca đầu thấy `FAILURES` event `disabled`; RED của R6-9: tạm bỏ `${FENCE}` khỏi câu `SUCCEEDED` của `finish` → ca hai thấy `SUCCEEDED` với `attempts_total: 1`. Hoàn nguyên; ghi cả hai lần chạy vào báo cáo task.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/integrations-races.ts test/e2e/integrations/deliver-races.e2e.spec.ts
git add test/support/integrations-races.ts test/e2e/integrations/deliver-races.e2e.spec.ts
git commit -m "test(integrations): auto-disable exactly once under queued failures, fenced stale results, rotation during an in-flight request"
```

---

### Task 13: Nối composition (R-X16, X-9); chaos giết worker giữa lúc gửi (W-30, W-34 phần lease)

(Sweep — job mất, lease hết hạn, xoá cứng endpoint — đã ở Task 11 Step 5: review I2.)

**Files:**
- Create: `test/chaos/integrations-worker-kill.spec.ts`, `test/support/composition-disable-probe.ts`, `test/integration/composition/disable-integrations.spec.ts`
- Modify: `src/boilerplate.module-keys.ts`, `src/boilerplate.modules.ts`, `test/unit/composition/compose.spec.ts`, `.env.example` (sinh lại)

**Interfaces:**
- Consumes: `IntegrationsSweepOrgHandler` (Task 11); `DeliverWebhookJob`, `deliveryJobId` (Task 5); `startWorker`, `killIfAlive` (`test/support/spawn-worker.ts`); `JobQueue` (`core/queue`); `composeAppModules`, `BOILERPLATE_MODULES`, `MODULE_REQUIRES` (`src/boilerplate.modules.ts`), `BoilerplateModuleKey` (`src/boilerplate.module-keys.ts`); `configRegistry`, `loadedModules`, `validateAllConfigs` (`core/config`); `queueRegistry`, `jobRegistry` (`core/queue`); `cronRegistry` (`core/scheduler/cron-definition.js`).
- Produces: composition (R-X16): khoá `integrations` của `BoilerplateModuleKey`, mục `integrations` trong `BOILERPLATE_MODULES` (sau mục cuối), `integrations: ['tenancy']` trong `MODULE_REQUIRES`; `test/support/composition-disable-probe.ts` (X-9, dùng chung cho 6A/6D).

- [ ] **Step 1: Test chaos (fail)**

`test/chaos/integrations-worker-kill.spec.ts` (W-30: giết worker thật ngay sau khi gửi; lease → sweep → gửi lại cùng `webhook-id`):
`test/chaos/integrations-worker-kill.spec.ts` (W-30: giết worker thật ngay sau khi gửi; lease → sweep → gửi lại cùng `webhook-id`):
```ts
import type { ChildProcess } from 'node:child_process';
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../src/core/database/index.js';
import { JobQueue } from '../../src/core/queue/index.js';
import { IntegrationsSweepOrgHandler } from '../../src/modules/integrations/application/sweep.handlers.js';
import { DeliverWebhookJob, deliveryJobId } from '../../src/modules/integrations/jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { integrationsCoreImports } from '../support/integrations-app.js';
import { deliveryRow, receiverEnv, seedPendingDelivery } from '../support/integrations-delivery.js';
import { orgQuery } from '../support/integrations-seed.js';
import { killIfAlive, startWorker } from '../support/spawn-worker.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../support/webhook-receiver.js';

const CHAOS_TIMEOUT_MS = 90_000;

describe('a worker killed mid-send loses nothing and never writes twice (spec SP6 W-30, W-31)', { timeout: CHAOS_TIMEOUT_MS }, () => {
  let receiver: WebhookReceiver;
  let app: INestApplication;
  let org: SeededOrg;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await createTestApp(integrationsCoreImports(), {});
    org = await seedOrg();
  });
  afterAll(async () => {
    for (const c of children.splice(0)) killIfAlive(c);
    receiver?.release();
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('SIGKILL after the request left: lease expires, the sweep reschedules as LEASE_EXPIRED, a new worker resends the same webhook-id', async () => {
    const env = { ...baseTestEnv(), ...receiverEnv(receiver), APP_ROLE: 'worker', WORKER_QUEUES: 'webhooks-out', INTEGRATIONS_DELIVERY_LEASE_MS: '60000' };
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    receiver.hold();
    const first = await startWorker(env);
    children.push(first.child);
    await app.get(JobQueue).enqueue(DeliverWebhookJob, { deliveryId: d.deliveryId }, { jobId: deliveryJobId(d.deliveryId, 1), meta: { orgId: org.orgId } });
    const [sent] = await receiver.waitFor(1, 30_000);
    first.child.kill('SIGKILL');
    receiver.release();
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe('SENDING');
    // Đưa lease về quá hạn + grace thay vì chờ 60 s (mốc thời gian, không phải may rủi).
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET lease_until = now() - interval '1 hour' WHERE public_id = $1`, [d.deliveryId]);
    const ctx = { payload: {}, meta: { orgId: org.orgId }, jobId: 'sweep', attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t') };
    expect((await app.get(OrgScope).run(org.orgId, () => app.get(IntegrationsSweepOrgHandler).handle(ctx))).leases).toBe(1);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'RETRY_SCHEDULED', last_error: 'LEASE_EXPIRED', attempts_total: 1 });
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1`, [d.deliveryId]);
    const second = await startWorker(env);
    children.push(second.child);
    await app.get(JobQueue).enqueue(DeliverWebhookJob, { deliveryId: d.deliveryId }, { jobId: deliveryJobId(d.deliveryId, 2), meta: { orgId: org.orgId } });
    const reqs = await receiver.waitFor(2, 30_000);
    expect(reqs[1]?.headers['webhook-id']).toBe(sent?.headers['webhook-id']);
    const until = Date.now() + 20_000;
    while ((await deliveryRow(org.orgId, d.deliveryId)).status !== 'SUCCEEDED' && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'SUCCEEDED', attempts_total: 2 });
  });
});
```
(Enqueue thẳng bằng `JobQueue` ngoài transaction (không có relay trong app test này). Vòng chờ `SUCCEEDED` là chờ worker con hoàn tất job, có hạn chót, không phải ép xen kẽ.)

Run: `pnpm vitest run --project chaos test/chaos/integrations-worker-kill.spec.ts`
Expected: FAIL — worker con (`AppWorkerModule`) chưa nạp integrations (composition chưa nối), job `integrations.deliver-webhook` không có ai consume, `receiver.waitFor` hết hạn.
- [ ] **Step 2: Nối composition (R-X16) và X-9 — mọi `@JobHandler` của module đã có (Task 11)**

Từ bước này worker đầy đủ (`AppWorkerModule`, `startWorker`, app process, smoke) nạp integrations; trước Task 11 `WorkerHost` sẽ từ chối vì job trên queue `webhooks-out`/`maintenance` chưa có handler (Task 6 ghi lý do).

`src/boilerplate.module-keys.ts`:
```ts
export type BoilerplateModuleKey = 'notifications' | 'identity' | 'tenancy' | 'entitlements' | 'integrations';
```
(Nếu 6A đã thêm `'files'`, giữ và thêm `'integrations'` sau mục cuối.)

`src/boilerplate.modules.ts`: thêm mục ngay sau mục cuối của `BOILERPLATE_MODULES` (sau `entitlements`, hoặc sau `files` nếu 6A đã merge):
```ts
  integrations: {
    load: async () => {
      const m = await import('./modules/integrations/index.js');
      return { api: m.IntegrationsModule.forApi(), worker: m.IntegrationsModule.forWorker() };
    },
  },
```
và trong `MODULE_REQUIRES`: `integrations: ['tenancy'],` (spec §5.2).

`test/unit/composition/compose.spec.ts`, ca `lists the boilerplate modules in import order…`: thêm `'integrations'` vào cuối mảng khoá kỳ vọng và `integrations: ['tenancy']` vào đối tượng `MODULE_REQUIRES` kỳ vọng (không đổi thứ tự khoá có sẵn).

`test/support/composition-disable-probe.ts`:
```ts
/**
 * X-9 (spec SP6 §16, UP-12b của SP7 với module thật): composition của ứng dụng với `disable: [<m>]`, rồi validate config và
 * in một dòng JSON về registry. Chạy: `node --import @swc-node/register/esm-register test/support/composition-disable-probe.ts <m>`.
 */
import { BOILERPLATE_MODULES, composeAppModules, type BoilerplateModuleKey } from '../../src/boilerplate.modules.js';
import { configRegistry, loadedModules, validateAllConfigs } from '../../src/core/config/index.js';
import { jobRegistry, queueRegistry } from '../../src/core/queue/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';
import { examplePlans } from '../../src/plans.example.js';

const isKey = (k: string): k is BoilerplateModuleKey => Object.hasOwn(BOILERPLATE_MODULES, k);
const key = process.argv[2] ?? '';
if (!isKey(key)) throw new Error(`composition-disable-probe: unknown module "${key}"`);
await composeAppModules({ disable: [key], features: { api: [], worker: [] }, plans: examplePlans });
let validation = 'ok';
try {
  validateAllConfigs();
} catch (err) {
  validation = err instanceof Error ? err.message : String(err);
}
const result = {
  loaded: [...loadedModules()],
  namespaces: configRegistry().map((e) => e.namespace),
  queues: queueRegistry().map((q) => q.name),
  jobs: jobRegistry().map((j) => j.name),
  crons: cronRegistry().map((c) => c.key),
  validation,
};
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
```
(`configRegistry()` trả `ConfigEntry` có `namespace`; `queueRegistry()`/`jobRegistry()` trả `QueueDef[]`/`JobDef[]` có `name`; đã đối chiếu `src/core/config/config.registry.ts:4`, `src/core/queue/job-definition.ts:74-75`.)

`test/integration/composition/disable-integrations.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseTestEnv } from '../../support/env.js';

const TS_LOADER = ['--import', '@swc-node/register/esm-register'];
/** Nạp TS qua swc (lạnh) và import cả cây module. */
const PROBE_TIMEOUT_MS = 90_000;
const Probe = z.object({
  loaded: z.array(z.string()),
  namespaces: z.array(z.string()),
  queues: z.array(z.string()),
  jobs: z.array(z.string()),
  crons: z.array(z.string()),
  validation: z.string(),
});

describe('disabling integrations really disables it (spec SP6 X-9, R-X16)', { timeout: PROBE_TIMEOUT_MS }, () => {
  it('no namespace, queue, job or cron of integrations; markModuleLoaded not called; config still validates', () => {
    const out = execFileSync(process.execPath, [...TS_LOADER, 'test/support/composition-disable-probe.ts', 'integrations'], {
      encoding: 'utf8',
      env: { ...process.env, ...baseTestEnv() },
      timeout: PROBE_TIMEOUT_MS,
    });
    const r = Probe.parse(JSON.parse(out.trim().split('\n').at(-1) ?? ''));
    expect(r.loaded).not.toContain('integrations');
    expect(r.loaded).toContain('tenancy');
    expect(r.namespaces).not.toContain('integrations');
    expect(r.queues).not.toContain('webhooks-out');
    expect(r.jobs.filter((j) => j.startsWith('integrations.'))).toEqual([]);
    expect(r.crons.filter((c) => c.startsWith('integrations.'))).toEqual([]);
    expect(r.validation).toBe('ok');
  });
});
```

- [ ] **Step 3: Chạy, sinh lại `.env.example`**

Run:
```bash
pnpm vitest run --project unit test/unit/composition test/unit/core/events
pnpm vitest run --project integration test/integration/composition
pnpm vitest run --project chaos test/chaos/integrations-worker-kill.spec.ts
pnpm typecheck && pnpm arch
pnpm env:example && git diff --stat .env.example
```
Expected:
- PASS.
- unit: `compose.spec.ts` (hằng mới), `cron-queue.spec.ts` (cron `integrations.sweep-orgs` ở `maintenance`), `event-flags.spec.ts` (giờ nạp cả event `integrations.*` qua `app.modules.ts`).
- integration: `module-isolation.spec.ts` (UP-12c) tự thêm ca `integrations` (`requires = ['tenancy', 'identity', 'notifications']`, cron mới toàn `integrations.*`); `disable-integrations.spec.ts` (X-9).
- chaos: worker con (`AppWorkerModule` có integrations) gửi, bị giết, sweep lấy lại, worker mới gửi lại cùng `webhook-id`.
- `.env.example` thêm khối `INTEGRATIONS_*` (23 env: 19 của spec §11.4 + `INTEGRATIONS_PARTITION_PREMAKE_MONTHS`, `INTEGRATIONS_MAX_LOCAL_FAILURES`, `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT`, `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG`; mỗi dòng có mô tả từ `.describe()`); `gen-env-example.ts` không đổi (R-X25).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/boilerplate.modules.ts src/boilerplate.module-keys.ts test/unit/composition test/integration/composition test/support/composition-disable-probe.ts test/chaos/integrations-worker-kill.spec.ts
git add src/boilerplate.modules.ts src/boilerplate.module-keys.ts test/unit/composition test/integration/composition/disable-integrations.spec.ts test/support/composition-disable-probe.ts test/chaos/integrations-worker-kill.spec.ts .env.example
git commit -m "feat(integrations): wire integrations into the boilerplate composition; a killed worker loses no delivery"
```

---

## Phần F — Dead-letter và API delivery, purge, hợp đồng OpenAPI (spec §8.3 "Dead-letter", "Gửi thử", "Xoá cứng org", "Hợp đồng công khai")

### Task 14: API delivery — danh sách (cursor), đọc, `retry`, `recover`, gửi thử; ma trận vai trò × route của 6C (W-12, W-13, W-16, W-33, R6-13, R6-14, ca org key của 3D) — Review Focus 5

**Files:**
- Create: `src/modules/integrations/application/delivery.service.ts`, `src/modules/integrations/http/delivery-cursor.ts`, `src/modules/integrations/http/webhook-deliveries.controller.ts`, `test/unit/modules/integrations/delivery-cursor.spec.ts`, `test/e2e/integrations/deliveries.e2e.spec.ts`, `test/e2e/integrations/route-matrix.e2e.spec.ts`
- Modify: `src/modules/integrations/ports/delivery-repository.ts`, `src/modules/integrations/infra/sql/sql-delivery.repository.ts`, `src/modules/integrations/http/schemas.ts`, `src/modules/integrations/integrations.module.ts`, `openapi.json`

**Interfaces:**
- Consumes: `cursorPageQuery`, `cursorPageSchema`, `Paginator.cursor`, `Idempotent` (`core/http`); `CoreErrors.INVALID_CURSOR`; `buildWebhookBody`, `WEBHOOK_TEST_EVENT_TYPE`, `WEBHOOK_TEST_EVENT_VERSION`, `DELIVERY_STATUSES`, `type DeliveryStatus` (Task 4); `deliveryJobId`, `DeliverWebhookJob`, `IntegrationsErrors`, `integrationsConfig` (Task 5); `EndpointRepository.find(publicId, 'SHARE')` (Task 8); `CREATED_AT_KEY_SQL`, `CREATED_AT_KEY_PATTERN` (Task 10); `SafeEnqueue`; test: `OrgRouteInventory.tenantRoutes()`, `PermissionCatalogueRegistry.merged()`, `systemRolePermissions`, `apiKeyEligibleKeys`, `supportPresetKeys`, `seedOrgApiKey`, `seedSupportGrant`, `seedStaffPrincipal`, `seedMember` (3A–3D); `seedPendingDelivery`, `deliveryRow`, `runDeliver`, `receiverEnv` (Task 11); `raceOnRowLock` (Task 12).
- Produces:
  - `type DeliveryView = { publicId: string; endpointPublicId: string; eventType: string; eventId: string; status: DeliveryStatus; attemptsTotal: number; nextAttemptAt: Date | null; lastAttemptAt: Date | null; lastStatusCode: number | null; lastError: LastError | null; completedAt: Date | null; createdAt: Date; createdAtKey: string }`.
  - `DeliveryRepository.view(publicId): Promise<DeliveryView | undefined>`, `.listByEndpoint(endpointId, q: { status?: DeliveryStatus; limit: number; after?: { createdAt: string; publicId: string } }): Promise<DeliveryView[]>`, `.requeue(publicId): Promise<{ attemptsTotal: number } | undefined>` (CAS `SUCCEEDED | EXHAUSTED | CANCELLED → PENDING`, `cycle_base = attempts_total`, `local_failures = 0` — R-X35), `.recover(endpointId, since, max): Promise<{ publicId: string; attemptsTotal: number }[]>`, `.hasRecoverable(endpointId, since): Promise<boolean>`.
  - `DeliveryService.list(endpointPublicId, q)`, `.get(publicId)`, `.retry(publicId)`, `.recover(endpointPublicId, since)`, `.sendTest(endpointPublicId)`.
  - `encodeDeliveryCursor(k)`, `decodeDeliveryCursor(raw)` (`http/delivery-cursor.ts`); HTTP `WebhookDeliveryResponse`, `deliveryOf(view)`, `DeliveryListQuery`, `WebhookDeliveryPage`, `RecoverBody`, `RecoverResponse`; route `GET …/webhook-endpoints/:endpointId/deliveries`, `POST …/webhook-endpoints/:endpointId/recover`, `POST …/webhook-endpoints/:endpointId/test`, `GET …/webhook-deliveries/:deliveryId`, `POST …/webhook-deliveries/:deliveryId/retry`.

- [ ] **Step 1: Test (fail)**

`test/unit/modules/integrations/delivery-cursor.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import { decodeDeliveryCursor, encodeDeliveryCursor } from '../../../../src/modules/integrations/http/delivery-cursor.js';

const KEY = { createdAt: '2026-10-07T01:02:03.456789Z', publicId: '0199a000-0000-7000-8000-000000000001' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('delivery cursor (spec SP6 §9.2, Review Focus 5)', () => {
  it('round-trips the microsecond key', () => {
    expect(decodeDeliveryCursor(encodeDeliveryCursor(KEY))).toEqual(KEY);
  });
  it.each([
    ['not base64url', '%%%'],
    ['non-canonical base64url (padding)', `${b64(JSON.stringify([KEY.createdAt, KEY.publicId]))}=`],
    ['not JSON', b64('nope')],
    ['an object, not a pair', b64(JSON.stringify({ a: 1 }))],
    ['a triple', b64(JSON.stringify([KEY.createdAt, KEY.publicId, 1]))],
    ['millisecond precision', b64(JSON.stringify(['2026-10-07T01:02:03.456Z', KEY.publicId]))],
    ['an impossible date', b64(JSON.stringify(['2026-02-30T00:00:00.000000Z', KEY.publicId]))],
    ['a non-uuid id', b64(JSON.stringify([KEY.createdAt, '42']))],
  ])('Review Focus 5: %s → 400 invalid_cursor', (_name, raw) => {
    try {
      decodeDeliveryCursor(raw);
      throw new Error('expected invalid_cursor');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err instanceof AppError && err.error.code).toBe('invalid_cursor');
    }
  });
});
```
`test/e2e/integrations/deliveries.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { endpointsUrl, startIntegrationsApp } from '../../support/integrations-app.js';
import { deliveryRow, receiverEnv, runDeliver, seedPendingDelivery } from '../../support/integrations-delivery.js';
import { raceOnRowLock } from '../../support/integrations-races.js';
import { inOrg, insertDelivery, insertMessage, orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

const PAGE = 2;
const idem = () => `k-${v7()}`;

describe('deliveries API (spec SP6 §8.3 "Dead-letter", "Gửi thử", §9.2)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  const deliveriesUrl = (id: string) => `/v1/orgs/${org.orgId}/webhook-deliveries/${id}`;
  const jobIdsOf = async (deliveryId: string) =>
    (
      await ownerQuery<{ payload: { jobId: string } }>(
        `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
        [org.orgId, deliveryId],
      )
    ).map((j) => j.payload.jobId);
  const terminal = async (status: 'EXHAUSTED' | 'CANCELLED' | 'SUCCEEDED', attempts = 3) => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = $2, next_attempt_at = NULL, attempts_total = $3, completed_at = now(),
         last_error = CASE WHEN $2 = 'SUCCEEDED' THEN NULL ELSE 'SERVER_ERROR' END WHERE public_id = $1`,
      [d.deliveryId, status, attempts],
    );
    return d;
  };
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({ env: { ...receiverEnv(receiver), INTEGRATIONS_RECOVER_BATCH_MAX: String(PAGE) } });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  beforeEach(() => {
    receiver.requests.length = 0;
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('GET a delivery: resource fields; attempts and errors; 404 for a malformed or unknown id', async () => {
    const d = await terminal('EXHAUSTED', 8);
    const res = await authed(app, owner).get(deliveriesUrl(d.deliveryId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: d.deliveryId,
      endpointId: d.endpoint.publicId,
      eventType: 'tenancy.org.updated',
      status: 'EXHAUSTED',
      attempts: 8,
      lastError: 'SERVER_ERROR',
      nextAttemptAt: null,
    });
    expect(res.body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await authed(app, owner).get(deliveriesUrl('nope'))).status).toBe(404);
    expect((await authed(app, owner).get(deliveriesUrl(v7()))).status).toBe(404);
  });
  it('list: newest first, cursor pages without gaps or repeats, ?status filters; Review Focus 5: a tampered cursor is 400 invalid_cursor, never 500', async () => {
    const first = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await inOrg(org.orgId, async (c) => {
      for (let i = 0; i < 4; i++) await insertDelivery(c, org.orgId, { endpoint: first.endpoint, message: await insertMessage(c, org.orgId) });
    });
    const base = `${endpointsUrl(org.orgId)}/${first.endpoint.publicId}/deliveries`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await authed(app, owner).get(`${base}?limit=${PAGE}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((x: { id: string }) => x.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const all = await orgQuery<{ public_id: string }>(
      org.orgId,
      `SELECT public_id::text FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC, public_id DESC`,
      [first.endpoint.id],
    );
    expect(seen).toEqual(all.map((r) => r.public_id));
    const pending = await authed(app, owner).get(`${base}?status=PENDING`);
    expect(pending.body.data).toHaveLength(5);
    expect((await authed(app, owner).get(`${base}?status=SUCCEEDED`)).body.data).toEqual([]);
    for (const bad of ['%%%', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["2026-10-07T00:00:00.000000Z","x"]').toString('base64url')]) {
      const res = await authed(app, owner).get(`${base}?cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    }
  });
  it('W-12 + R-X35: retry of an EXHAUSTED delivery starts a new cycle (cycle_base = attempts_total, local_failures = 0) and queues a<n+1>; it then succeeds', async () => {
    const d = await terminal('EXHAUSTED', 8);
    // Như một delivery hết vì lỗi của ta (R-X35): phát lại phải trả lại đủ INTEGRATIONS_MAX_LOCAL_FAILURES lần.
    await orgQuery(org.orgId, `UPDATE webhook_deliveries SET local_failures = 5, last_error = 'BULKHEAD_FULL' WHERE public_id = $1`, [d.deliveryId]);
    const res = await authed(app, owner).post(`${deliveriesUrl(d.deliveryId)}/retry`).set('idempotency-key', idem()).send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'PENDING', attempts_total: 8, cycle_base: 8, local_failures: 0, completed_at: null });
    expect(await jobIdsOf(d.deliveryId)).toEqual([`webhook-${d.deliveryId}-a9`]);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'SUCCEEDED', attempts_total: 9 });
  });
  it('R6-13: retry of a PENDING or SENDING delivery is 409 webhook_delivery_not_retryable; of a disabled endpoint 409 webhook_endpoint_disabled', async () => {
    const pending = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const r1 = await authed(app, owner).post(`${deliveriesUrl(pending.deliveryId)}/retry`).set('idempotency-key', idem()).send();
    expect([r1.status, r1.body.code]).toEqual([409, 'webhook_delivery_not_retryable']);
    const dead = await terminal('CANCELLED');
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`, [dead.endpoint.id]);
    const r2 = await authed(app, owner).post(`${deliveriesUrl(dead.deliveryId)}/retry`).set('idempotency-key', idem()).send();
    expect([r2.status, r2.body.code]).toEqual([409, 'webhook_endpoint_disabled']);
  });
  it('W-13: recover requeues EXHAUSTED/CANCELLED since a date in batches of INTEGRATIONS_RECOVER_BATCH_MAX with hasMore; SUCCEEDED and older ones stay', async () => {
    const a = await terminal('EXHAUSTED');
    const endpoint = a.endpoint;
    const extra = await inOrg(org.orgId, async (c) => {
      const ids: string[] = [];
      for (const status of ['CANCELLED', 'EXHAUSTED', 'SUCCEEDED']) {
        const { publicId } = await insertDelivery(c, org.orgId, { endpoint, message: await insertMessage(c, org.orgId) });
        await c.query(
          `UPDATE webhook_deliveries SET status = $2, next_attempt_at = NULL, attempts_total = 1, completed_at = now(),
             last_error = CASE WHEN $2 = 'SUCCEEDED' THEN NULL ELSE 'SERVER_ERROR' END WHERE public_id = $1`,
          [publicId, status],
        );
        ids.push(publicId);
      }
      return ids;
    });
    const url = `${endpointsUrl(org.orgId)}/${endpoint.publicId}/recover`;
    const since = new Date(Date.now() - 3600_000).toISOString();
    const p1 = await authed(app, owner).post(url).set('idempotency-key', idem()).send({ since });
    expect(p1.status).toBe(200);
    expect(p1.body).toEqual({ requeued: PAGE, hasMore: true });
    const p2 = await authed(app, owner).post(url).set('idempotency-key', idem()).send({ since });
    expect(p2.body).toEqual({ requeued: 1, hasMore: false });
    expect((await deliveryRow(org.orgId, extra[2] ?? '')).status).toBe('SUCCEEDED');
    const future = await authed(app, owner).post(url).set('idempotency-key', idem()).send({ since: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.body).toEqual({ requeued: 0, hasMore: false });
  });
  it('R6-14: a retry queued on the delivery row and a recover running meanwhile move it exactly once', async () => {
    const d = await terminal('EXHAUSTED');
    const since = new Date(Date.now() - 3600_000).toISOString();
    // Một người chờ: `retry` xếp hàng trên CAS của dòng; `recover` gặp `SKIP LOCKED` nên chạy xong ngay, bỏ qua dòng đang bị khoá.
    const [retry, recover] = await raceOnRowLock(org.orgId, `SELECT 1 FROM webhook_deliveries WHERE public_id = $1 FOR UPDATE`, [d.deliveryId], 1, () =>
      Promise.all([
        authed(app, owner).post(`${deliveriesUrl(d.deliveryId)}/retry`).set('idempotency-key', idem()).send(),
        authed(app, owner).post(`${endpointsUrl(org.orgId)}/${d.endpoint.publicId}/recover`).set('idempotency-key', idem()).send({ since }),
      ]),
    );
    const moved = (retry.status === 200 ? 1 : 0) + (recover.body.requeued ?? 0);
    expect(moved).toBe(1);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({ status: 'PENDING', cycle_base: 3 });
    expect(await jobIdsOf(d.deliveryId)).toEqual([`webhook-${d.deliveryId}-a4`]);
  });
  it('W-16: POST …/test creates a webhook.test message and delivery (201 + Location), the receiver gets data.endpointId', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const res = await authed(app, owner).post(`${endpointsUrl(org.orgId)}/${d.endpoint.publicId}/test`).set('idempotency-key', idem()).send();
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(deliveriesUrl(res.body.id));
    expect(res.body).toMatchObject({ eventType: 'webhook.test', status: 'PENDING', endpointId: d.endpoint.publicId });
    await runDeliver(app, org.orgId, res.body.id);
    const [req] = await receiver.waitFor(1);
    expect(JSON.parse(req?.body ?? '{}')).toMatchObject({ type: 'webhook.test', version: 1, data: { endpointId: d.endpoint.publicId } });
  });
  it('W-33: a disabled endpoint refuses test and recover (409); after enabling, recover sends the cancelled deliveries', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`, [d.endpoint.id]);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe('CANCELLED');
    const base = `${endpointsUrl(org.orgId)}/${d.endpoint.publicId}`;
    const since = new Date(Date.now() - 3600_000).toISOString();
    expect((await authed(app, owner).post(`${base}/test`).set('idempotency-key', idem()).send()).status).toBe(409);
    expect((await authed(app, owner).post(`${base}/recover`).set('idempotency-key', idem()).send({ since })).status).toBe(409);
    await orgQuery(org.orgId, `UPDATE webhook_endpoints SET status = 'ACTIVE', disabled_reason = NULL WHERE id = $1`, [d.endpoint.id]);
    expect((await authed(app, owner).post(`${base}/recover`).set('idempotency-key', idem()).send({ since })).body.requeued).toBe(1);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe('SUCCEEDED');
  });
});
```
`test/e2e/integrations/route-matrix.e2e.spec.ts` (mẫu G-6 của 3A/3D, chỉ route của 6C; tập quyền tính từ catalogue gộp lúc chạy, R-X24):
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgRouteInventory, type TenantRoute } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { systemRolePermissions } from '../../../src/modules/tenancy/domain/system-roles.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  apiKeyEligibleKeys, seedMember, seedOrg, seedOrgApiKey, seedSupportGrant, supportPresetKeys, type SeededOrg,
} from '../../support/tenancy-seed.js';

type Column = 'OWNER' | 'ADMIN' | 'MEMBER' | 'KEY' | 'SUPPORT';
const COLUMNS: readonly Column[] = ['OWNER', 'ADMIN', 'MEMBER', 'KEY', 'SUPPORT'];

describe('role × route matrix of the 6C routes (spec SP3 G-6 generated from metadata, SP6 §9.1, S6-A35)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let routes: TenantRoute[];
  const people: SeededPrincipal[] = [];
  const as: Partial<Record<Exclude<Column, 'KEY'>, SeededPrincipal>> = {};
  let keyToken = '';
  beforeAll(async () => {
    app = await startIntegrationsApp();
    routes = app
      .get(OrgRouteInventory)
      .tenantRoutes()
      .filter((r) => /webhook-(endpoints|deliveries)/.test(r.template));
    const owner = await seedUserPrincipal();
    const admin = await seedUserPrincipal();
    const member = await seedUserPrincipal();
    const support = await seedStaffPrincipal();
    people.push(owner, admin, member, support);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    keyToken = (await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: apiKeyEligibleKeys(merged) })).token;
    await seedSupportGrant(org, { grantee: { authUserId: support.authUserId }, grantedByMemberId: org.owner.memberId, permissions: supportPresetKeys(merged) });
    Object.assign(as, { OWNER: owner, ADMIN: admin, MEMBER: member, SUPPORT: support });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(people);
  });

  it('lists every route of spec §9.2 for 6C', () => {
    expect(routes.map((r) => r.id).sort()).toEqual(
      [
        'GET v1/orgs/:orgId/webhook-endpoints',
        'POST v1/orgs/:orgId/webhook-endpoints',
        'GET v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'PATCH v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'PATCH v1/orgs/:orgId/webhook-endpoints/:endpointId/destination',
        'DELETE v1/orgs/:orgId/webhook-endpoints/:endpointId',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/rotate-secret',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/test',
        'POST v1/orgs/:orgId/webhook-endpoints/:endpointId/recover',
        'GET v1/orgs/:orgId/webhook-endpoints/:endpointId/deliveries',
        'GET v1/orgs/:orgId/webhook-deliveries/:deliveryId',
        'POST v1/orgs/:orgId/webhook-deliveries/:deliveryId/retry',
      ].sort(),
    );
  });
  it('every (column × route) cell passes the guard iff the catalogue grants every key; an org key never creates or edits an endpoint (S6-A35)', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    for (const column of COLUMNS) {
      const perms =
        column === 'KEY' ? new Set(apiKeyEligibleKeys(merged)) : column === 'SUPPORT' ? new Set(supportPresetKeys(merged)) : systemRolePermissions(column, merged);
      for (const route of routes) {
        if (route.policy.kind !== 'PERMISSIONS') throw new Error(`${route.id}: expected a permission policy`);
        const allowed = route.policy.keys.every((k) => perms.has(k));
        const url = `/${route.template.replace(':orgId', org.orgId).replace(':endpointId', v7()).replace(':deliveryId', v7())}`;
        const agent = request(app.getHttpServer());
        const m = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
        const auth: [string, string] = column === 'KEY' ? ['x-api-key', keyToken] : ['authorization', `Bearer ${as[column]?.bearer ?? ''}`];
        const req = agent[m](url).set(auth[0], auth[1]).set('if-match', '*').set('idempotency-key', `k-${v7()}`);
        const r = m === 'get' ? await req : await req.send({});
        // Qua guard thì gặp 404/422 (id ngẫu nhiên, body rỗng); bị chặn thì 403 (org key ở route @SessionOnly: api_key_not_allowed_here).
        const denied = r.status === 403;
        if (r.status >= 500 || denied === allowed) failures.push(`${column} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403'})`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
```
(`m` ép kiểu từ `route.method` đã kiểm ở `OrgRouteInventory` (chỉ GET/POST/PUT/PATCH/DELETE); 6C không khai `PUT`. Ép hẹp có lý do, không `any`.)

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations/delivery-cursor.spec.ts
pnpm vitest run --project integration test/e2e/integrations/deliveries.e2e.spec.ts test/e2e/integrations/route-matrix.e2e.spec.ts
```
Expected: FAIL (route và codec chưa có).

- [ ] **Step 2: Cursor**

`src/modules/integrations/http/delivery-cursor.ts`:
```ts
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { CREATED_AT_KEY_PATTERN } from '../infra/sql/created-at-key.js';

/**
 * Cursor keyset `(created_at, public_id)` giảm dần, mờ với client: base64url chuẩn tắc của `[createdAtMicroIso, publicId]`.
 * Không ký: sửa cursor chỉ đổi vị trí bắt đầu trong tập client vốn được xem (lọc theo endpoint của path + RLS). Mọi dạng hỏng
 * → `400 invalid_cursor` trước khi chạm SQL (Review Focus 5); không bao giờ để Postgres ép kiểu hỏng (22007/22008 → 500).
 */
export type DeliveryCursorKey = { createdAt: string; publicId: string };
const Pair = z.tuple([z.string().regex(CREATED_AT_KEY_PATTERN), z.uuid()]);
const ISO_MS_LENGTH = 23; // `YYYY-MM-DDTHH:mm:ss.sss`
const invalid = () => new AppError(CoreErrors.INVALID_CURSOR, { detail: 'The cursor is malformed or no longer valid', expected: true });

export const encodeDeliveryCursor = (k: DeliveryCursorKey): string => Buffer.from(JSON.stringify([k.createdAt, k.publicId]), 'utf8').toString('base64url');

export function decodeDeliveryCursor(raw: string): DeliveryCursorKey {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid();
  }
  const r = Pair.safeParse(value);
  if (!r.success) throw invalid();
  const [createdAt, publicId] = r.data;
  // Ngày không tồn tại (30/2) đổi giá trị khi qua Date: so phần mili giây để bắt.
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, ISO_MS_LENGTH) !== createdAt.slice(0, ISO_MS_LENGTH)) throw invalid();
  return { createdAt, publicId: publicId.toLowerCase() };
}
```

- [ ] **Step 3: Repository**

`src/modules/integrations/ports/delivery-repository.ts`: thêm (import `type DeliveryStatus, type LastError`)
```ts
export type DeliveryView = {
  publicId: string;
  endpointPublicId: string;
  eventType: string;
  eventId: string;
  status: DeliveryStatus;
  attemptsTotal: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: LastError | null;
  completedAt: Date | null;
  createdAt: Date;
  createdAtKey: string;
};
```
và vào lớp:
```ts
  abstract view(publicId: string): Promise<DeliveryView | undefined>;
  /** `limit` dòng, `(created_at, public_id)` giảm dần, sau `after` nếu có. */
  abstract listByEndpoint(endpointId: string, q: { status?: DeliveryStatus; limit: number; after?: { createdAt: string; publicId: string } }): Promise<DeliveryView[]>;
  /** CAS `SUCCEEDED | EXHAUSTED | CANCELLED → PENDING` với chu kỳ mới (`cycle_base = attempts_total`), R6-13, R6-14. */
  abstract requeue(publicId: string): Promise<{ attemptsTotal: number } | undefined>;
  /** Tối đa `max` delivery `EXHAUSTED | CANCELLED` của endpoint có `created_at >= since`, cùng CAS như `requeue`; `SKIP LOCKED`. */
  abstract recover(endpointId: string, since: string, max: number): Promise<{ publicId: string; attemptsTotal: number }[]>;
  abstract hasRecoverable(endpointId: string, since: string): Promise<boolean>;
```
`src/modules/integrations/infra/sql/sql-delivery.repository.ts`: thêm
```ts
const VIEW_COLUMNS = `d.public_id::text AS public_id, e.public_id::text AS endpoint_public_id, m.event_type, m.event_id::text AS event_id, d.status,
  d.attempts_total, d.next_attempt_at, d.last_attempt_at, d.last_status_code, d.last_error, d.completed_at, d.created_at,
  ${CREATED_AT_KEY_SQL('d')} AS created_at_key`;
const VIEW_FROM = `FROM webhook_deliveries d
  JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id
  JOIN webhook_messages m ON m.org_id = d.org_id AND m.id = d.message_id AND m.created_at = d.created_at`;
const ViewRow = z.object({
  public_id: z.uuid(),
  endpoint_public_id: z.uuid(),
  event_type: z.string(),
  event_id: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  attempts_total: z.number().int(),
  next_attempt_at: z.coerce.date().nullable(),
  last_attempt_at: z.coerce.date().nullable(),
  last_status_code: z.number().int().nullable(),
  last_error: z.enum(LAST_ERRORS).nullable(),
  completed_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  created_at_key: z.string(),
});
const toView = (raw: unknown): DeliveryView => {
  const r = ViewRow.parse(raw);
  return {
    publicId: r.public_id,
    endpointPublicId: r.endpoint_public_id,
    eventType: r.event_type,
    eventId: r.event_id,
    status: r.status,
    attemptsTotal: r.attempts_total,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptAt: r.last_attempt_at,
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    createdAtKey: r.created_at_key,
  };
};
/** Phát lại = chu kỳ mới: lịch đầy đủ (`cycle_base = attempts_total`) và trần lỗi của ta đầy đủ (`local_failures = 0`, R-X35). */
const REQUEUE_SET = `status = 'PENDING', cycle_base = d.attempts_total, local_failures = 0, next_attempt_at = clock_timestamp(), completed_at = NULL,
  version = d.version + 1, updated_at = clock_timestamp()`;
const TERMINAL = `d.status IN ('SUCCEEDED', 'EXHAUSTED', 'CANCELLED')`;
const RECOVERABLE = `d.org_id = app_current_org() AND d.endpoint_id = ?::bigint AND d.status IN ('EXHAUSTED', 'CANCELLED') AND d.created_at >= ?::timestamptz`;
```
và vào lớp (import `DELIVERY_STATUSES`, `LAST_ERRORS`, `type DeliveryStatus` từ `../../domain/webhook-delivery.js`, `type DeliveryView`):
```ts
  async view(publicId: string): Promise<DeliveryView | undefined> {
    const [r] = await this.db.execute(`SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid`, [publicId]);
    return r ? toView(r) : undefined;
  }
  async listByEndpoint(
    endpointId: string,
    q: { status?: DeliveryStatus; limit: number; after?: { createdAt: string; publicId: string } },
  ): Promise<DeliveryView[]> {
    const where = ['d.org_id = app_current_org()', 'd.endpoint_id = ?::bigint'];
    const params: unknown[] = [endpointId];
    if (q.status !== undefined) {
      where.push('d.status = ?');
      params.push(q.status);
    }
    if (q.after !== undefined) {
      where.push('(d.created_at, d.public_id) < (?::timestamptz, ?::uuid)');
      params.push(q.after.createdAt, q.after.publicId);
    }
    params.push(q.limit);
    return (
      await this.db.execute(`SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.public_id DESC LIMIT ?`, params)
    ).map(toView);
  }
  async requeue(publicId: string): Promise<{ attemptsTotal: number } | undefined> {
    const [r] = z
      .array(z.object({ attempts_total: z.number().int() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_deliveries AS d SET ${REQUEUE_SET} WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid AND ${TERMINAL} RETURNING d.attempts_total`,
          [publicId],
        ),
      );
    return r ? { attemptsTotal: r.attempts_total } : undefined;
  }
  async recover(endpointId: string, since: string, max: number): Promise<{ publicId: string; attemptsTotal: number }[]> {
    return z
      .array(z.object({ public_id: z.uuid(), attempts_total: z.number().int() }))
      .parse(
        await this.db.execute(
          `WITH picked AS (
             SELECT d.id, d.created_at FROM webhook_deliveries d WHERE ${RECOVERABLE}
             ORDER BY d.created_at, d.id LIMIT ? FOR UPDATE SKIP LOCKED)
           UPDATE webhook_deliveries AS d SET ${REQUEUE_SET}
           FROM picked WHERE d.id = picked.id AND d.created_at = picked.created_at AND d.org_id = app_current_org() AND ${TERMINAL}
           RETURNING d.public_id::text AS public_id, d.attempts_total`,
          [endpointId, since, max],
        ),
      )
      .map((r) => ({ publicId: r.public_id, attemptsTotal: r.attempts_total }));
  }
  async hasRecoverable(endpointId: string, since: string): Promise<boolean> {
    const [r] = z
      .array(z.object({ more: z.boolean() }))
      .parse(await this.db.execute(`SELECT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE ${RECOVERABLE}) AS more`, [endpointId, since]));
    return r?.more ?? false;
  }
```
(R6-14: `retry` khoá dòng bằng chính CAS `UPDATE`, `recover` bằng `FOR UPDATE SKIP LOCKED` rồi CAS có lại `${TERMINAL}`; bên tới sau thấy `PENDING` → `retry` 0 dòng (409), `recover` bỏ qua dòng đang bị khoá hoặc đã `PENDING`.)

- [ ] **Step 4: Service**

`src/modules/integrations/application/delivery.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import type { DeliveryStatus } from '../domain/webhook-delivery.js';
import { WEBHOOK_TEST_EVENT_TYPE, WEBHOOK_TEST_EVENT_VERSION, buildWebhookBody } from '../domain/webhook-payload.js';
import { IntegrationsErrors } from '../errors.js';
import { integrationsConfig } from '../integrations.config.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import { DeliveryRepository, type DeliveryView } from '../ports/delivery-repository.js';
import { EndpointRepository, type EndpointRow } from '../ports/endpoint-repository.js';

const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });
const disabled = () => new AppError(IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED, { expected: true });

/** Spec SP6 §8.3 "Dead-letter" (S6-A33: tập `EXHAUSTED`/`CANCELLED` trong DB), "Gửi thử". */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly enqueue: SafeEnqueue,
    @Inject(integrationsConfig.KEY) private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async list(
    endpointPublicId: string,
    q: { status?: DeliveryStatus; limit: number; after?: { createdAt: string; publicId: string } },
  ): Promise<{ rows: DeliveryView[]; hasMore: boolean }> {
    return this.uow.run(async () => {
      const ep = await this.endpoints.find(endpointPublicId, 'NONE');
      if (!ep) throw notFound();
      const rows = await this.deliveries.listByEndpoint(ep.id, { ...q, limit: q.limit + 1 });
      return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
    });
  }

  async get(publicId: string): Promise<DeliveryView> {
    const v = await this.uow.run(() => this.deliveries.view(publicId));
    if (!v) throw notFound();
    return v;
  }

  async retry(publicId: string): Promise<DeliveryView> {
    return this.uow.run(async () => {
      const v = await this.deliveries.view(publicId);
      if (!v) throw notFound();
      // Thứ tự khoá của đường API: endpoint (`FOR SHARE`: chặn tắt endpoint giữa chừng) rồi delivery (CAS).
      await this.activeEndpoint(v.endpointPublicId);
      const r = await this.deliveries.requeue(publicId);
      if (!r) throw new AppError(IntegrationsErrors.WEBHOOK_DELIVERY_NOT_RETRYABLE, { expected: true });
      await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId: publicId }, { jobId: deliveryJobId(publicId, r.attemptsTotal + 1) });
      const after = await this.deliveries.view(publicId);
      if (!after) throw new Error(`delivery ${publicId} vanished inside its retry transaction`);
      return after;
    });
  }

  async recover(endpointPublicId: string, since: Date): Promise<{ requeued: number; hasMore: boolean }> {
    return this.uow.run(async () => {
      const ep = await this.activeEndpoint(endpointPublicId);
      const sinceIso = since.toISOString();
      const rows = await this.deliveries.recover(ep.id, sinceIso, this.cfg.recoverBatchMax);
      for (const r of rows) await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId: r.publicId }, { jobId: deliveryJobId(r.publicId, r.attemptsTotal + 1) });
      return { requeued: rows.length, hasMore: await this.deliveries.hasRecoverable(ep.id, sinceIso) };
    });
  }

  async sendTest(endpointPublicId: string): Promise<DeliveryView> {
    return this.uow.run(async () => {
      const ep = await this.activeEndpoint(endpointPublicId);
      const built = buildWebhookBody({
        type: WEBHOOK_TEST_EVENT_TYPE,
        version: WEBHOOK_TEST_EVENT_VERSION,
        timestamp: new Date().toISOString(),
        data: { endpointId: ep.publicId },
      });
      if (built.kind === 'TOO_LARGE') throw new Error('the webhook.test body can never exceed the format limit');
      const message = await this.deliveries.insertMessage({ eventId: v7(), eventType: WEBHOOK_TEST_EVENT_TYPE, eventVersion: WEBHOOK_TEST_EVENT_VERSION, body: built.body });
      const [deliveryId] = await this.deliveries.insertDeliveries(message, [ep.id]);
      if (!deliveryId) throw new Error('webhook.test delivery insert returned no id');
      await this.enqueue.enqueue(DeliverWebhookJob, { deliveryId }, { jobId: deliveryJobId(deliveryId, 1) });
      const v = await this.deliveries.view(deliveryId);
      if (!v) throw new Error(`webhook.test delivery ${deliveryId} vanished inside its transaction`);
      return v;
    });
  }

  /** Endpoint chưa xoá (404 nếu không) và `ACTIVE` (409 nếu không), khoá `FOR SHARE` tới hết transaction. */
  private async activeEndpoint(publicId: string): Promise<EndpointRow> {
    const ep = await this.endpoints.find(publicId, 'SHARE');
    if (!ep) throw notFound();
    if (ep.status !== 'ACTIVE') throw disabled();
    return ep;
  }
}
```
(`retry` của delivery thuộc endpoint đã xoá mềm: `find` không thấy endpoint → `404`, hợp lý vì endpoint đã biến mất khỏi API.)

- [ ] **Step 5: HTTP**

`src/modules/integrations/http/schemas.ts`: thêm (import `cursorPageQuery`, `cursorPageSchema` từ `core/http`; `DELIVERY_STATUSES`, `LAST_ERRORS` từ domain; `type DeliveryView` từ port)
```ts
export const DeliveryListQuery = cursorPageQuery().extend({ status: z.enum(DELIVERY_STATUSES).optional() });
export const WebhookDeliveryResponse = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  eventType: z.string(),
  eventId: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  /** Số lần claim (kể cả lần bị huỷ vì endpoint không còn hoạt động). */
  attempts: z.number().int(),
  nextAttemptAt: iso.nullable(),
  lastAttemptAt: iso.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.enum(LAST_ERRORS).nullable(),
  completedAt: iso.nullable(),
  createdAt: iso,
});
export const WebhookDeliveryPage = cursorPageSchema(WebhookDeliveryResponse);
export const deliveryOf = (v: DeliveryView): z.infer<typeof WebhookDeliveryResponse> => ({
  id: v.publicId,
  endpointId: v.endpointPublicId,
  eventType: v.eventType,
  eventId: v.eventId,
  status: v.status,
  attempts: v.attemptsTotal,
  nextAttemptAt: v.nextAttemptAt?.toISOString() ?? null,
  lastAttemptAt: v.lastAttemptAt?.toISOString() ?? null,
  lastStatusCode: v.lastStatusCode,
  lastError: v.lastError,
  completedAt: v.completedAt?.toISOString() ?? null,
  createdAt: v.createdAt.toISOString(),
});
export const RecoverBody = z.object({ since: z.iso.datetime({ offset: true }).transform((s) => new Date(s)) }).strict();
export const RecoverResponse = z.object({ requeued: z.number().int(), hasMore: z.boolean() });
```
`src/modules/integrations/http/webhook-deliveries.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, Paginator, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { DeliveryService } from '../application/delivery.service.js';
import { IntegrationsErrors } from '../errors.js';
import { WebhookPermissions } from '../permissions.js';
import { decodeDeliveryCursor, encodeDeliveryCursor } from './delivery-cursor.js';
import { DeliveryListQuery, RecoverBody, RecoverResponse, WebhookDeliveryPage, WebhookDeliveryResponse, deliveryOf, publicIdOrNotFound } from './schemas.js';

/** Spec SP6 §9.2 (dead-letter, gửi thử). `retry`, `recover`, `test` là `@Idempotent()`: response không chứa secret. */
@Controller('v1/orgs/:orgId')
export class WebhookDeliveriesController {
  constructor(
    private readonly deliveries: DeliveryService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
  ) {}

  @Get('webhook-endpoints/:endpointId/deliveries')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookDeliveryPage)
  @ApiProblems(CoreErrors.INVALID_CURSOR, CoreErrors.NOT_FOUND)
  async list(@Param('endpointId') endpointId: string, @Query({ schema: DeliveryListQuery }) q: z.infer<typeof DeliveryListQuery>) {
    const after = q.cursor === undefined ? undefined : decodeDeliveryCursor(q.cursor);
    const { rows, hasMore } = await this.deliveries.list(publicIdOrNotFound(endpointId), { status: q.status, limit: q.limit, after });
    const last = rows.at(-1);
    return this.pages.cursor(
      rows.map((v) => serialize(WebhookDeliveryResponse, deliveryOf(v))),
      { hasMore, nextCursor: hasMore && last ? encodeDeliveryCursor({ createdAt: last.createdAtKey, publicId: last.publicId }) : null },
    );
  }

  @Post('webhook-endpoints/:endpointId/recover')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(RecoverResponse)
  @ApiProblems(IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED, CoreErrors.NOT_FOUND, CoreErrors.VALIDATION_FAILED)
  async recover(@Param('endpointId') endpointId: string, @Body({ schema: RecoverBody }) body: z.infer<typeof RecoverBody>) {
    return serialize(RecoverResponse, await this.deliveries.recover(publicIdOrNotFound(endpointId), body.since));
  }

  @Post('webhook-endpoints/:endpointId/test')
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED, CoreErrors.NOT_FOUND)
  async test(@Param('endpointId') endpointId: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const v = await this.deliveries.sendTest(publicIdOrNotFound(endpointId));
    setLocation(res, `/v1/orgs/${this.orgId()}/webhook-deliveries/${v.publicId}`);
    return serialize(WebhookDeliveryResponse, deliveryOf(v));
  }

  @Get('webhook-deliveries/:deliveryId')
  @WebhookPermissions.require('webhooks.read')
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(CoreErrors.NOT_FOUND)
  async get(@Param('deliveryId') deliveryId: string) {
    return serialize(WebhookDeliveryResponse, deliveryOf(await this.deliveries.get(publicIdOrNotFound(deliveryId))));
  }

  @Post('webhook-deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  @WebhookPermissions.require('webhooks.write')
  @Idempotent()
  @ApiOk(WebhookDeliveryResponse)
  @ApiProblems(IntegrationsErrors.WEBHOOK_DELIVERY_NOT_RETRYABLE, IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED, CoreErrors.NOT_FOUND)
  async retry(@Param('deliveryId') deliveryId: string) {
    return serialize(WebhookDeliveryResponse, deliveryOf(await this.deliveries.retry(publicIdOrNotFound(deliveryId))));
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined) throw new Error('WebhookDeliveriesController ran without an org context');
    return id;
  }
}
```
`src/modules/integrations/integrations.module.ts`: `IntegrationsHttpModule` thêm `WebhookDeliveriesController` vào `controllers`, `DeliveryService` vào `providers`.

- [ ] **Step 6: Chạy, sinh lại OpenAPI**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/integrations/delivery-cursor.spec.ts
pnpm vitest run --project integration test/e2e/integrations
pnpm typecheck && pnpm arch
pnpm build && pnpm openapi:export && git diff --stat openapi.json
```
Expected: PASS; ma trận: OWNER/ADMIN qua guard mọi route; MEMBER 403 mọi route; KEY qua guard đúng các `GET` (có `webhooks.read`), 403 mọi route ghi (S6-A35, ca "org key không tạo được endpoint" của cặp 3D/6C); SUPPORT qua guard đúng các `GET`.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/unit/modules/integrations/delivery-cursor.spec.ts test/e2e/integrations
git add src/modules/integrations test/unit/modules/integrations/delivery-cursor.spec.ts test/e2e/integrations/deliveries.e2e.spec.ts test/e2e/integrations/route-matrix.e2e.spec.ts openapi.json
git commit -m "feat(integrations): delivery list with a keyset cursor, read, retry, recover and test sends; role x route matrix of the webhook routes"
```

---

### Task 15: Participant xoá cứng org `integrations` (order 120, W-41) và purge end-to-end qua `JobQueue` thật (X-3)

**Files:**
- Create: `src/modules/integrations/application/integrations-purge.participant.ts`, `test/integration/integrations/purge.spec.ts`, `test/integration/integrations/purge-e2e.spec.ts`
- Modify: `src/modules/integrations/integrations.module.ts`

**Interfaces:**
- Consumes: `OrgPurgeParticipant`, `OrgPurgeParticipantContributor` (tenancy index); `INTEGRATIONS_PURGE_STATEMENTS` (Task 2); `INTEGRATIONS_PURGE_ORDER` (Task 4); `PurgeOrgHandler`, `OrgPurgeParticipantRegistry` (tenancy application); `PurgeOrgJob`, `purgeJobId` (`src/modules/tenancy/jobs.ts`); `startWorker`, `killIfAlive`; `JobQueue`; `pgFields` (`core/database`).
- Produces: `IntegrationsPurgeParticipant` (chỉ worker); bằng chứng W-41, X-3 phần 6C.

- [ ] **Step 1: Test (fail)**

`test/integration/integrations/purge.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, pgFields } from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { OrgPurgeParticipantRegistry } from '../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import { FAKE_SECRET_ENC, inOrg, insertDelivery, insertEndpoint, insertMessage, orgQuery } from '../../support/integrations-seed.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const TABLES = ['webhook_deliveries', 'webhook_messages', 'webhook_endpoint_event_types', 'webhook_endpoint_secrets', 'webhook_endpoints'];
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
const makeDue = (orgId: string) =>
  orgQuery(orgId, `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [orgId]);
const seedWebhookRows = (orgId: string) =>
  inOrg(orgId, async (c) => {
    const endpoint = await insertEndpoint(c, orgId);
    await c.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`, [orgId, endpoint.id, FAKE_SECRET_ENC]);
    await insertDelivery(c, orgId, { endpoint, message: await insertMessage(c, orgId) });
  });
const countsOf = async (orgId: string) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await orgQuery<{ n: number }>(orgId, `SELECT count(*)::int AS n FROM ${t}`))[0]?.n ?? -1;
  return out;
};

describe('org purge participant integrations (spec SP6 §8.3 "Xoá cứng org", R-X5, W-41)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    app = await createTestApp(integrationsCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
  });

  it('registered at order 120 between the other participants and tenancy core', () => {
    const order = app
      .get(OrgPurgeParticipantRegistry)
      .participants()
      .map((p) => [p.key, p.order] as const);
    expect(order).toContainEqual(['integrations', 120]);
  });
  it('a purge removes every webhook row of that org, both partitioned tables included, child before parent; another org keeps its rows', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    await seedWebhookRows(a.orgId);
    await seedWebhookRows(b.orgId);
    await makeDue(a.orgId);
    expect(await app.get(OrgScope).run(a.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(a.orgId)))).toBe('purged');
    expect(Object.values(await countsOf(a.orgId))).toEqual([0, 0, 0, 0, 0]);
    expect(Object.values(await countsOf(b.orgId)).every((n) => n > 0)).toBe(true);
  });
});

describe('without the integrations participant a purge fails loud (23001), nothing removed', () => {
  let app: INestApplication;
  let o: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    o = await seedOrg();
    await seedWebhookRows(o.orgId);
    await makeDue(o.orgId);
  });
  afterAll(async () => {
    await o?.dispose();
    await app?.close();
  });
  it('organizations delete hits FK RESTRICT from webhook_endpoints', async () => {
    const err: unknown = await app
      .get(OrgScope)
      .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
      .catch((e: unknown) => e);
    expect(pgFields(err)?.sqlState).toBe('23001');
    expect((await countsOf(o.orgId)).webhook_endpoints).toBe(1);
  });
});
```
`test/integration/integrations/purge-e2e.spec.ts` (X-3: worker thật, queue `maintenance`, job `tenancy.org.purge` qua `JobQueue`):
```ts
import type { ChildProcess } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../../src/core/queue/index.js';
import { PurgeOrgJob, purgeJobId } from '../../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import { FAKE_SECRET_ENC, inOrg, insertDelivery, insertEndpoint, insertMessage, orgQuery } from '../../support/integrations-seed.js';
import { killIfAlive, startWorker } from '../../support/spawn-worker.js';
import { seedOrg } from '../../support/tenancy-seed.js';

const E2E_TIMEOUT_MS = 90_000;

describe('org purge end to end on a real worker (spec SP6 X-3, 6C part)', { timeout: E2E_TIMEOUT_MS }, () => {
  let app: INestApplication;
  let worker: ChildProcess | undefined;
  beforeAll(async () => {
    app = await createTestApp(integrationsCoreImports());
    worker = (await startWorker({ ...baseTestEnv(), APP_ROLE: 'worker', WORKER_QUEUES: 'maintenance' })).child;
  });
  afterAll(async () => {
    if (worker) killIfAlive(worker);
    await app?.close();
  });

  it('an org with endpoints, secrets, messages and deliveries leaves no webhook row; tenancy.org.purged is in the outbox', async () => {
    const org = await seedOrg();
    await inOrg(org.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, org.orgId);
      await c.query(`INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`, [org.orgId, endpoint.id, FAKE_SECRET_ENC]);
      await insertDelivery(c, org.orgId, { endpoint, message: await insertMessage(c, org.orgId) });
      await c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [org.orgId]);
    });
    await app.get(JobQueue).enqueue(PurgeOrgJob, {}, { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const [row] = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`, [org.orgId]);
      if ((row?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const t of ['webhook_deliveries', 'webhook_messages', 'webhook_endpoint_event_types', 'webhook_endpoint_secrets', 'webhook_endpoints'])
      expect(await orgQuery(org.orgId, `SELECT 1 FROM ${t}`)).toEqual([]);
    expect((await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`, [org.orgId])).length).toBe(1);
  });
});
```
(Org đã purge nên không gọi `dispose()`. Vòng chờ là chờ worker con hoàn tất job, có hạn chót.)

Run:
```bash
pnpm vitest run --project integration test/integration/integrations/purge.spec.ts test/integration/integrations/purge-e2e.spec.ts
```
Expected: FAIL ở ca đầu (participant chưa đăng ký) và purge của org có dòng webhook ném `23001`.

- [ ] **Step 2: Participant**

`src/modules/integrations/application/integrations-purge.participant.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../../core/database/index.js';
import { OrgPurgeParticipant, OrgPurgeParticipantContributor } from '../../tenancy/index.js';
import { INTEGRATIONS_PURGE_ORDER } from '../constants.js';
import { INTEGRATIONS_PURGE_STATEMENTS } from '../infra/sql/integrations-purge.sql.js';

/**
 * Xoá cứng (spec SP6 §8.3, R-X5, addendum 3D §A4): `order = 120`, trước tenancy core (1000) vì `webhook_endpoints` trỏ tới
 * `organizations`. Chạy TRONG transaction purge (OrgScope của org), chỉ DB, con trước cha; quên bảng nào thì purge fail to
 * (23001). Bảng partitioned không FK tới `organizations` (R-X27): participant này là thứ dọn chúng.
 */
@Injectable()
@OrgPurgeParticipantContributor({ key: 'integrations', order: INTEGRATIONS_PURGE_ORDER })
export class IntegrationsPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly db: Db) {
    super();
  }
  async purge(): Promise<void> {
    for (const sql of INTEGRATIONS_PURGE_STATEMENTS) await this.db.execute(sql);
  }
}
```
`src/modules/integrations/integrations.module.ts`: `IntegrationsWorkerModule.providers` thêm `IntegrationsPurgeParticipant`.

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project integration test/integration/integrations/purge.spec.ts test/integration/integrations/purge-e2e.spec.ts test/integration/tenancy test/integration/entitlements/provisioning.spec.ts
pnpm arch
```
Expected: PASS; `provisioning.spec.ts` (ca R-1 của 4A) vẫn xanh (nó khẳng định vị trí tương đối, không khẳng định tập participant đóng); `no-orphans` không còn cảnh báo cho `integrations-purge.sql.ts`.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/integrations test/integration/integrations
git add src/modules/integrations test/integration/integrations/purge.spec.ts test/integration/integrations/purge-e2e.spec.ts
git commit -m "feat(integrations): org purge participant at order 120 removes every webhook row, partitioned tables included"
```

---

### Task 16: Mục `webhooks` của OpenAPI 3.1 cho mọi event `webhook: true`, hợp đồng payload dưới `oasdiff` (S6-A36, W-43)

**Files:**
- Modify: `src/core/http/openapi.ts`, `openapi.json`
- Create: `test/unit/core/http/openapi-webhooks.spec.ts`
- Create (chỉ nhánh fallback của spike W2): `test/unit/core/http/webhook-contract.spec.ts`

**Interfaces:**
- Consumes: `eventRegistry`, `type EventDef` (`src/core/events/event-definition.ts`, import thẳng file lá, không qua barrel: barrel của `core/events` kéo `EventsModule` → `DatabaseModule` vào mọi consumer của `core/http`, cùng lý do luật `http-no-database-barrel`); `toOpenApiSchema` (nội bộ `openapi.ts`); `type OpenAPIObject` (`@nestjs/swagger`); kết luận spike W2 (Task 1).
- Produces: `webhookDocs(defs?): { webhooks: NonNullable<OpenAPIObject['webhooks']>; schemas: Record<string, SchemaObject> }` (export từ `core/http/openapi.ts`); `buildOpenApi` gắn `doc.webhooks` (khoá `<type>@<version>`, header `webhook-id`/`-timestamp`/`-signature`, body envelope `{ type, version, timestamp, data }`).

- [ ] **Step 1: Test (fail)**

`test/unit/core/http/openapi-webhooks.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../../../../src/core/events/index.js';
import { webhookDocs } from '../../../../src/core/http/openapi.js';

const Hooked = defineEvent({ type: 'fixturewh.thing.happened', version: 2, schema: z.object({ thingId: z.uuid() }), audit: false, webhook: true });
const Quiet = defineEvent({ type: 'fixturewh.thing.hidden', version: 1, schema: z.object({ x: z.string() }), audit: false, webhook: false });

describe('OpenAPI 3.1 webhooks section (spec SP6 §8.3 "Hợp đồng công khai", S6-A36)', () => {
  const { webhooks } = webhookDocs([Hooked, Quiet]);
  it('one entry per webhook:true event keyed <type>@<version>; webhook:false events are absent', () => {
    expect(Object.keys(webhooks)).toEqual(['fixturewh.thing.happened@2']);
  });
  it('POST with the three Standard Webhooks headers and the envelope { type, version, timestamp, data } as the body', () => {
    const post = webhooks['fixturewh.thing.happened@2']?.post;
    expect(post?.parameters?.map((p) => ('name' in p ? p.name : ''))).toEqual(['webhook-id', 'webhook-timestamp', 'webhook-signature']);
    const body = post?.requestBody;
    const schema = body && 'content' in body ? body.content['application/json']?.schema : undefined;
    expect(schema).toMatchObject({
      type: 'object',
      required: ['type', 'version', 'timestamp', 'data'],
      properties: {
        type: { const: 'fixturewh.thing.happened' },
        version: { const: 2 },
        data: { type: 'object', required: ['thingId'] },
      },
    });
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/http/openapi-webhooks.spec.ts`
Expected: FAIL (`webhookDocs` chưa có).

- [ ] **Step 2: Cài**

`src/core/http/openapi.ts`: thêm import và hàm, gắn vào `buildOpenApi`:
```ts
import { eventRegistry, type EventDef } from '../events/event-definition.js';
```
```ts
type Webhooks = NonNullable<OpenAPIObject['webhooks']>;
/** Header Standard Webhooks (spec SP6 §8.3 bước 3), bắt buộc ở mọi lần gửi. */
const WEBHOOK_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;

/**
 * Mục `webhooks` của OpenAPI 3.1 (S6-A36): mỗi event `webhook: true` (hợp đồng công khai do module phát event khai, R-X3) là
 * một webhook `<type>@<version>`. `oasdiff` của CI so mục này như so `paths`, nên đổi payload phá vỡ hợp đồng bị chặn như
 * đổi API. Đọc registry của core (không import module nào); mục có mặt theo cờ của event, như cờ là hợp đồng của chính module đó.
 */
export function webhookDocs(defs: readonly EventDef[] = eventRegistry()): { webhooks: Webhooks; schemas: Record<string, SchemaObject> } {
  const schemas: Record<string, SchemaObject> = {};
  const webhooks: Webhooks = {};
  for (const d of [...defs].filter((x) => x.webhook).sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version)) {
    const envelope = z.object({ type: z.literal(d.type), version: z.literal(d.version), timestamp: z.iso.datetime({ offset: true }), data: d.schema });
    const { schema, components } = toOpenApiSchema(envelope, 'output');
    Object.assign(schemas, components);
    webhooks[`${d.type}@${d.version}`] = {
      post: {
        summary: `${d.type} version ${d.version}`,
        parameters: WEBHOOK_HEADERS.map((name) => ({ name, in: 'header' as const, required: true, schema: { type: 'string' } })),
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: { '2XX': { description: 'Any 2xx acknowledges the delivery; anything else is retried on the schedule' } },
      },
    };
  }
  return { webhooks, schemas };
}
```
trong `buildOpenApi`, sau khối gán `doc.components`:
```ts
  const { webhooks, schemas } = webhookDocs();
  if (Object.keys(webhooks).length > 0) {
    doc.webhooks = webhooks;
    doc.components = { ...doc.components, schemas: { ...doc.components?.schemas, ...schemas } };
  }
```
(Đã đối chiếu kiểu của `@nestjs/swagger` (`open-api-spec.interface.d.ts`): `webhooks?: Record<string, PathItemObject>`, `ParameterObject.in: 'query' | 'header' | 'path' | 'cookie'`, `ResponsesObject` là `Record<string, ResponseObject>` nên khoá `2XX` hợp lệ.)

- [ ] **Step 3: Chạy, sinh lại OpenAPI**

Run:
```bash
pnpm vitest run --project unit test/unit/core/http
pnpm typecheck && pnpm arch
pnpm build && pnpm openapi:export
node -e 'const d=require("./openapi.json");console.log(Object.keys(d.webhooks??{}).sort().join("\n"))'
```
Expected: PASS; lệnh cuối in đúng sáu khoá `tenancy.member.added@1`, `tenancy.member.removed@1`, `tenancy.member.role_changed@1`, `tenancy.org.deleted@1`, `tenancy.org.restored@1`, `tenancy.org.updated@1` (cộng `files.file.deleted@1`, `files.file.ready@1` nếu 6A đã merge).

- [ ] **Step 4: Hợp đồng dưới `oasdiff` (W-43) — theo kết luận spike W2**

**Nhánh (a) — W2 đạt:** kiểm một lần rằng đổi phá vỡ trên chính `openapi.json` mới bị bắt:
```bash
mkdir -p "$TMPDIR/sp6c-w43"
cp openapi.json "$TMPDIR/sp6c-w43/base.json"
node -e '
const fs=require("fs");const p=process.env.TMPDIR+"/sp6c-w43/";const d=JSON.parse(fs.readFileSync(p+"base.json"));
const s=d.webhooks["tenancy.org.updated@1"].post.requestBody.content["application/json"].schema;
s.properties.data.required=[];delete s.properties.data.properties.orgId;fs.writeFileSync(p+"rev.json",JSON.stringify(d));'
docker run --rm -v "$TMPDIR/sp6c-w43:/s:ro" <IMAGE của W2> breaking /s/base.json /s/rev.json --fail-on ERR; echo "exit=$?"
rm -r "$TMPDIR/sp6c-w43"
```
Expected: `exit=1` và một dòng breaking ở `tenancy.org.updated@1`. Ghi output vào báo cáo task (Task 19 chép vào ADR 0020 cạnh W2). Không file test nào được thêm: CI (`ci.yml:47`) đã chạy `oasdiff` trên `openapi.json`.

**Nhánh (b) — W2 không đạt:** `test/unit/core/http/webhook-contract.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Fallback của S6-A36 (spike W2: oasdiff không so mục `webhooks`): webhook đã có trên `origin/main` phải giữ nguyên schema;
 * thêm webhook mới được; đổi payload phải lên version (khoá `<type>@<version+1>`). So `openapi.json` đã commit.
 */
type Doc = { webhooks?: Record<string, unknown> };
const mainDoc = (): Doc | undefined => {
  try {
    return JSON.parse(execFileSync('git', ['show', 'origin/main:openapi.json'], { encoding: 'utf8' })) as Doc;
  } catch {
    return undefined;
  }
};
describe('published webhook payloads never change in place (S6-A36 fallback)', () => {
  it('every webhook of origin/main is still present with the same schema', () => {
    const base = mainDoc()?.webhooks ?? {};
    const rev = (JSON.parse(readFileSync('openapi.json', 'utf8')) as Doc).webhooks ?? {};
    const broken = Object.keys(base).filter((k) => JSON.stringify(base[k]) !== JSON.stringify(rev[k]));
    expect(broken).toEqual([]);
  });
});
```
(`JSON.parse` trả `unknown`-tương đương; ép về kiểu `Doc` hẹp có lý do: chỉ đọc `webhooks`, so bằng chuỗi. `origin/main` không có `openapi.json` hoặc không có `webhooks` → tập rỗng, ca xanh; lần đầu 6C merge cũng vậy.)
Run: `pnpm vitest run --project unit test/unit/core/http/webhook-contract.spec.ts` → PASS; thử phá một khoá trong `openapi.json` cục bộ (sau khi `origin/main` đã có mục `webhooks`) → FAIL, hoàn nguyên. Ghi vào báo cáo task.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/core/http/openapi.ts test/unit/core/http
git add src/core/http/openapi.ts test/unit/core/http/openapi-webhooks.spec.ts openapi.json
# chỉ nhánh (b): git add test/unit/core/http/webhook-contract.spec.ts
git commit -m "feat(http): OpenAPI 3.1 webhooks section for every webhook:true event, so payload changes are diffed like the API"
```

---

### Task 17: Sự cố và PII — DB mất khi tạo endpoint và khi ghi kết quả gửi (503, không mất delivery), endpoint chậm (W-46), không PII trong log (X-7)

**Files:**
- Create: `test/chaos/integrations-outages.spec.ts`, `test/chaos/integrations-slow-endpoint.spec.ts`, `test/e2e/integrations/pii-logs.e2e.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy`, `type TcpProxy` (`test/support/tcp-proxy.ts`); `SqlEndpointRepository.countLive`, `SqlDeliveryRepository.finish` (spy trên instance của app, mẫu `chaos/entitlements-outages.spec.ts`); `startAppProcess`, `stopAppProcess`, `type AppProcess` (`test/support/app-process.ts`); `JobQueue.enqueueMany`; mọi support của Task 8–14.
- Produces: bằng chứng tiêu chí 13 (DB lỗi → `503`), W-46 (số đo ghi ADR 0020 ở Task 19), X-7 cho 6C.

- [ ] **Step 1: Test chaos DB**

`test/chaos/integrations-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqlDeliveryRepository } from '../../src/modules/integrations/infra/sql/sql-delivery.repository.js';
import { SqlEndpointRepository } from '../../src/modules/integrations/infra/sql/sql-endpoint.repository.js';
import { getInfra } from '../support/infra.js';
import { endpointsUrl, startIntegrationsApp } from '../support/integrations-app.js';
import { deliveryRow, receiverEnv, runDeliver, seedPendingDelivery } from '../support/integrations-delivery.js';
import { orgQuery } from '../support/integrations-seed.js';
import { authed } from '../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { startWebhookReceiver, type WebhookReceiver } from '../support/webhook-receiver.js';

const RECOVERY = { timeout: 30_000, interval: 250 };

describe('the database lost under the integrations paths (spec SP6 criterion 13)', () => {
  let proxy: TcpProxy;
  let receiver: WebhookReceiver;
  let app: INestApplication;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({ env: { ...receiverEnv(receiver), DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), THROTTLE_DEFAULT_LIMIT: '100000' } });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    if (proxy) proxy.state.blackhole = false;
    vi.restoreAllMocks();
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('creating an endpoint while the DB disappears under the count answers 503, not 500, and leaves no endpoint row', async () => {
    const repo = app.get(SqlEndpointRepository);
    const original = repo.countLive.bind(repo);
    vi.spyOn(repo, 'countLive').mockImplementationOnce(() => {
      proxy.state.blackhole = true;
      return original();
    });
    const res = await authed(app, owner).post(endpointsUrl(org.orgId)).send({ url: 'https://hooks.example.test/chaos', eventTypes: ['tenancy.org.updated'] });
    proxy.state.blackhole = false;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');
    await vi.waitFor(async () => {
      expect(await orgQuery(org.orgId, `SELECT 1 FROM webhook_endpoints WHERE url = 'https://hooks.example.test/chaos'`)).toEqual([]);
    }, RECOVERY);
  });
  it('losing the DB while recording a sent result leaves the delivery SENDING with its lease (the sweep recovers it), the job fails loud', async () => {
    const d = await seedPendingDelivery(app, org.orgId, { url: receiver.url() });
    const repo = app.get(SqlDeliveryRepository);
    const original = repo.finish.bind(repo);
    vi.spyOn(repo, 'finish').mockImplementationOnce((...args: Parameters<SqlDeliveryRepository['finish']>) => {
      proxy.state.blackhole = true;
      return original(...args);
    });
    await expect(runDeliver(app, org.orgId, d.deliveryId)).rejects.toThrow();
    proxy.state.blackhole = false;
    await vi.waitFor(async () => {
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({ status: 'SENDING', attempts_total: 1 });
      expect(row.lease_until).not.toBeNull();
    }, RECOVERY);
    expect(receiver.requests).toHaveLength(1);
  });
});
```
`test/chaos/integrations-slow-endpoint.spec.ts` (W-46; `QUEUE_IO_CONCURRENCY` = 20, giá trị thật của code; trần in-flight R-X35 mặc định 4 — với nó, endpoint chậm chỉ giữ tối đa 4 slot, các job còn lại của nó bị từ chối claim trong vài ms và hẹn lại, nên endpoint khoẻ chỉ còn chờ hàng đợi BullMQ trôi qua chứ không chờ `timeout × (chờ / concurrency)`; cận của spec vẫn là cận trên, số đo thật ghi lại để thấy khoảng cách):
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/core/queue/index.js';
import { DeliverWebhookJob, deliveryJobId } from '../../src/modules/integrations/jobs.js';
import { startIntegrationsApp } from '../support/integrations-app.js';
import { deliveryRow, receiverEnv, seedPendingDelivery } from '../support/integrations-delivery.js';
import { inOrg, orgQuery } from '../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../support/webhook-receiver.js';

const WAITING = 1000;
const CONCURRENCY = 20;
const TIMEOUT_MS = 1000;
/** `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` mặc định (R-X35). */
const MAX_INFLIGHT = 4;
/** Cận của spec W-46: timeout × (chờ / concurrency), cộng biên khởi động và dispatch. */
const BOUND_MS = TIMEOUT_MS * (WAITING / CONCURRENCY) * 1.5 + 10_000;

describe('one slow endpoint does not starve the others beyond the computed bound (spec SP6 W-46)', { timeout: BOUND_MS + 60_000 }, () => {
  let app: INestApplication;
  let slow: WebhookReceiver;
  let fast: WebhookReceiver;
  let org: SeededOrg;
  beforeAll(async () => {
    slow = await startWebhookReceiver();
    fast = await startWebhookReceiver();
    app = await startIntegrationsApp({
      consumeWebhooks: true,
      env: {
        ...receiverEnv(slow),
        RESILIENCE_ALLOWED_PORTS: `80,443,${slow.port},${fast.port}`,
        INTEGRATIONS_WEBHOOK_TIMEOUT_MS: String(TIMEOUT_MS),
        QUEUE_IO_CONCURRENCY: String(CONCURRENCY),
      },
    });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await slow?.close();
    await fast?.close();
  });

  it(`${WAITING} deliveries to a timing-out endpoint, then one to a healthy endpoint: the healthy one succeeds within ${Math.round(BOUND_MS / 1000)} s`, async () => {
    slow.respondWith(...Array.from({ length: WAITING }, () => ({ status: 204, delayMs: TIMEOUT_MS * 3 })));
    const first = await seedPendingDelivery(app, org.orgId, { url: slow.url() });
    const ids = await inOrg(org.orgId, async (c) => {
      const { rows } = await c.query<{ public_id: string }>(
        `WITH m AS (
           INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body)
           SELECT $1, gen_random_uuid(), 'tenancy.org.updated', 1, '{}' FROM generate_series(1, $2) RETURNING id, created_at)
         INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
         SELECT gen_random_uuid(), $1, $3::bigint, m.id, m.created_at, 'PENDING', now() FROM m RETURNING public_id::text`,
        [org.orgId, WAITING - 1, first.endpoint.id],
      );
      return [first.deliveryId, ...rows.map((r) => r.public_id)];
    });
    const queue = app.get(JobQueue);
    await queue.enqueueMany(ids.map((id) => ({ job: DeliverWebhookJob, payload: { deliveryId: id }, opts: { jobId: deliveryJobId(id, 1), meta: { orgId: org.orgId } } })));
    const healthy = await seedPendingDelivery(app, org.orgId, { url: fast.url() });
    const t0 = Date.now();
    await queue.enqueue(DeliverWebhookJob, { deliveryId: healthy.deliveryId }, { jobId: deliveryJobId(healthy.deliveryId, 1), meta: { orgId: org.orgId } });
    // Lấy mẫu số SENDING của endpoint chậm trong lúc chờ (số đo phụ; chứng minh tất định của trần ở `deliver-inflight.e2e.spec.ts`).
    let maxSending = 0;
    while ((await deliveryRow(org.orgId, healthy.deliveryId)).status !== 'SUCCEEDED') {
      if (Date.now() - t0 > BOUND_MS) throw new Error(`healthy delivery not done after ${BOUND_MS} ms`);
      const [s] = await orgQuery<{ n: number }>(org.orgId, `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'SENDING'`, [
        first.endpoint.id,
      ]);
      maxSending = Math.max(maxSending, s?.n ?? 0);
      await new Promise((r) => setTimeout(r, 200));
    }
    const ms = Date.now() - t0;
    const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(org.orgId, `SELECT count(*)::int AS n FROM webhook_deliveries WHERE last_error = 'TIMEOUT'`);
    process.stdout.write(
      `${JSON.stringify({ event: 'webhook_w46', waiting: WAITING, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, maxInflight: MAX_INFLIGHT, healthyMs: ms, timeouts: n, maxSending })}\n`,
    );
    expect(ms).toBeLessThanOrEqual(BOUND_MS);
    expect(maxSending).toBeLessThanOrEqual(MAX_INFLIGHT);
  });
});
```
(`gen_random_uuid()` sinh v4 cho dữ liệu tải của test, không phải id của app; quy tắc v7 áp cho id do app sinh. Số đo `webhook_w46` vào báo cáo task, Task 19 chép vào ADR 0020 — spec §16 W-46 "số đo ghi vào plan".)

- [ ] **Step 2: Test PII (X-7) trên process thật**

`test/e2e/integrations/pii-logs.e2e.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { receiverEnv } from '../../support/integrations-delivery.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { startWebhookReceiver, type WebhookReceiver } from '../../support/webhook-receiver.js';

const FLUSH_MS = 1_000;
const QUERY_TOKEN = `qtok-${v7()}`;
const ORG_NAME_MARK = `PII Org ${v7().slice(-12)}`;

describe('no URL, secret, signature or webhook body in api/worker logs (spec SP6 §15, X-7)', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  let base = '';
  const forbidden = new Set<string>([QUERY_TOKEN, ORG_NAME_MARK]);
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    const env = {
      ...baseTestEnv(),
      ...receiverEnv(receiver),
      LOG_LEVEL: 'debug',
      HTTP_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      WORKER_QUEUES: 'events,notifications,webhooks-out',
      INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
      INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
    };
    [api, worker] = await Promise.all([startAppProcess('test/support/api-entry.ts', env), startAppProcess('test/support/worker-entry.ts', env)]);
    base = `http://127.0.0.1:${api.port}`;
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
    await org?.dispose();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('create (one refused URL, one accepted with a query token), a failing then a succeeding delivery: no URL, secret, signature, webhook body or receiver response is logged', async () => {
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${owner.bearer}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const hookUrl = `${receiver.url('/pii')}?token=${QUERY_TOKEN}`;
    forbidden.add(hookUrl);
    const refused = await call('POST', `/v1/orgs/${org.orgId}/webhook-endpoints`, { url: `https://10.0.0.9/x?token=${QUERY_TOKEN}`, eventTypes: ['tenancy.org.updated'] });
    expect(refused.status).toBe(422);
    const created = await call('POST', `/v1/orgs/${org.orgId}/webhook-endpoints`, { url: hookUrl, eventTypes: ['tenancy.org.updated'] });
    expect(created.status).toBe(201);
    const { secret } = (await created.json()) as { secret: string };
    forbidden.add(secret);
    forbidden.add(secret.slice('whsec_'.length));
    // Body của response receiver (có thể chứa dữ liệu của khách) không bao giờ được log (M2).
    const RECEIVER_BODY = `receiver-said-no-${v7()}`;
    forbidden.add(RECEIVER_BODY);
    receiver.respondWith({ status: 500, body: RECEIVER_BODY });
    const got = await call('GET', `/v1/orgs/${org.orgId}`);
    expect((await call('PATCH', `/v1/orgs/${org.orgId}`, { name: ORG_NAME_MARK }, { 'if-match': got.headers.get('etag') ?? '' })).status).toBe(200);
    const reqs = await receiver.waitFor(2, 30_000);
    for (const r of reqs) {
      forbidden.add(String(r.headers['webhook-signature']).split(' ')[0]?.split(',')[1] ?? '');
      // Marker của body webhook (M2): chính chuỗi body đã nhận — duy nhất (mang `timestamp` và id của event) và đúng là thứ
      // phải không lọt vào log. Payload `tenancy.org.updated` không mang tên org, nên tên org không phải marker của body.
      forbidden.add(r.body);
    }
    expect(reqs[0]?.body).toBe(reqs[1]?.body);
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    const logs = `${api?.output() ?? ''}\n${worker?.output() ?? ''}`;
    for (const value of forbidden) if (value.length > 0) expect(logs, `log leaks ${value.slice(0, 12)}…`).not.toContain(value);
    expect(logs).toContain('webhook_url_refused');
  });
});
```
(`(await created.json()) as { secret: string }`: `fetch` trả `unknown`-tương đương; ép hẹp đọc một trường đã khẳng định `201`. Lần gửi thứ nhất `500` (body `RECEIVER_BODY`) đi nhánh retry, lần hai thành công với cùng body đã ký (body tuần tự hoá một lần). `ORG_NAME_MARK` vẫn nằm trong tập cấm vì là dữ liệu cá nhân của tenancy đi qua cùng luồng, không phải vì body webhook mang nó.)

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project chaos test/chaos/integrations-outages.spec.ts test/chaos/integrations-slow-endpoint.spec.ts
pnpm vitest run --project integration test/e2e/integrations/pii-logs.e2e.spec.ts
```
Expected: PASS; số đo `webhook_w46` in ra (ghi vào báo cáo task).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/chaos/integrations-outages.spec.ts test/chaos/integrations-slow-endpoint.spec.ts test/e2e/integrations/pii-logs.e2e.spec.ts
git add test/chaos/integrations-outages.spec.ts test/chaos/integrations-slow-endpoint.spec.ts test/e2e/integrations/pii-logs.e2e.spec.ts
git commit -m "test(integrations): DB loss answers 503 and loses no delivery, a slow endpoint stays within the W-46 bound, no URL, secret or body in logs"
```

---

## Phần G — Prod-like, tài liệu, bàn giao

### Task 18: Prod-like trên image production — schema 6C chạy từ `dist`, webhook thật tới receiver HTTPS trong network compose (X-4), đo image (X-6, ADR 0013 "SP6 (6C)")

**Files:**
- Create: `test/smoke/integrations.smoke.spec.ts`, `test/smoke/webhook-receiver.mjs`
- Modify: `test/smoke/compose.smoke.yaml`, `test/smoke/gen-certs.sh`, `test/smoke/smoke-app-env.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `compose`, `psql`, `logsSince`, `assertCleanLogs`, `workerHealth` (`test/smoke/smoke-support.ts`); `verifiedDevice`, `PASSWORD`, `Device.call(method, path, { body, headers })` (`test/smoke/smoke-devices.ts`); `smokeSubnet()` (`test/smoke/smoke-env.ts`); `Mailpit`; `PARTITIONED_TABLES_6C`, `PARTITION_OWNER_FUNCTIONS_6C`, `SWEEP_DEFINER_FUNCTIONS_6C` (Task 2); `Webhook` (`standardwebhooks`, chạy ở host).
- Produces: smoke 6C (schema, luồng webhook ký thật trên TLS, log sạch); service `webhook-receiver` chỉ của smoke; dòng "Số đo SP6 (6C)" của ADR 0013.

- [ ] **Step 1: Receiver HTTPS và compose của smoke**

`test/smoke/webhook-receiver.mjs` (chạy bằng node của chính image app, chứng chỉ của CA smoke):
```js
// Receiver webhook CHỈ của smoke (spec SP6 X-4): HTTPS 443 bằng chứng chỉ của CA smoke, ghi nhận request vào bộ nhớ,
// `GET /received` trả JSON để test đọc qua `docker compose exec`. Không xác minh chữ ký: test ở host làm việc đó.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const received = [];
const server = createServer({ key: readFileSync('/certs/server.key'), cert: readFileSync('/certs/server.crt') }, (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return res.writeHead(200).end('ok');
  if (req.method === 'GET' && req.url === '/received') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(received));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(204).end();
  });
});
server.listen(443, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```
`test/smoke/compose.smoke.yaml`: thêm service (trước khối `volumes:`):
```yaml
  # Receiver webhook của smoke (spec SP6 X-4): HTTPS trong network compose; worker tin CA qua NODE_EXTRA_CA_CERTS và
  # RESILIENCE_SSRF_ALLOW_CIDRS = subnet của compose (chỉ env smoke). Chạy bằng node của chính image app (distroless).
  webhook-receiver:
    image: ${SMOKE_APP_IMAGE}
    pull_policy: never
    profiles: [app]
    entrypoint: ['/nodejs/bin/node', '/receiver/webhook-receiver.mjs']
    command: []
    # User 65532 của image nghe cổng 443 (Docker mặc định đã cho; ghi tường minh để không phụ thuộc phiên bản Docker).
    sysctls: { net.ipv4.ip_unprivileged_port_start: '0' }
    environment: { NODE_EXTRA_CA_CERTS: /certs/ca.crt }
    volumes: ['./test/smoke/webhook-receiver.mjs:/receiver/webhook-receiver.mjs:ro', 'smoke-certs:/certs:ro']
    healthcheck:
      test: ['CMD', '/nodejs/bin/node', '-e', "fetch('https://localhost/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      retries: 30
```
`test/smoke/gen-certs.sh`: dòng SAN thành
```bash
printf 'subjectAltName=DNS:postgres,DNS:pgbouncer,DNS:redis,DNS:mailpit,DNS:webhook-receiver,DNS:localhost,IP:127.0.0.1\n' > san.ext
```
(Nếu 6A đã thêm `DNS:minio` vào cùng dòng, giữ và thêm `DNS:webhook-receiver`.)

`test/smoke/smoke-app-env.ts`: import `smokeSubnet` từ `./smoke-env.js` và thêm vào đối tượng trả về của `smokeAppEnv`:
```ts
  // SP6 6C (X-4): receiver webhook nằm trong subnet của compose; chỉ env smoke mở subnet này cho HttpClient/UrlGuard.
  RESILIENCE_SSRF_ALLOW_CIDRS: smokeSubnet(),
```

- [ ] **Step 2: Ca smoke**

`test/smoke/integrations.smoke.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { Mailpit } from '../support/mailpit.js';
import { PARTITIONED_TABLES_6C, PARTITION_OWNER_FUNCTIONS_6C, SWEEP_DEFINER_FUNCTIONS_6C } from '../support/core-catalog.js';
import { PASSWORD, verifiedDevice } from './smoke-devices.js';
import { assertCleanLogs, compose, logsSince, psql, workerHealth } from './smoke-support.js';

const Received = z.array(z.object({ path: z.string(), headers: z.record(z.string(), z.unknown()), body: z.string() }));
const DELIVERY_WAIT_MS = 60_000;
const received = () =>
  Received.parse(
    JSON.parse(
      compose([
        'exec',
        '-T',
        'webhook-receiver',
        '/nodejs/bin/node',
        '-e',
        "fetch('https://localhost/received').then(r=>r.text()).then(t=>process.stdout.write(t))",
      ]),
    ),
  );

/** Plan 6C trên image production (`NODE_ENV=production`, TLS mọi nơi, PgBouncer, migrate từ `dist`). */
describe('prod-like smoke: plan 6C (integrations)', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const since = new Date().toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  const forbidden: string[] = [PASSWORD];

  it('the webhook schema migrated from dist: partitioned tables owned by partition_owner, definer functions with their owners, catalogue rows', () => {
    for (const t of PARTITIONED_TABLES_6C) {
      expect(psql(`SELECT pg_get_userbyid(relowner) || ':' || relkind FROM pg_class WHERE relname = '${t}'`)).toBe('partition_owner:p');
      expect(Number(psql(`SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.${t}'::regclass`))).toBeGreaterThanOrEqual(4);
    }
    for (const f of PARTITION_OWNER_FUNCTIONS_6C)
      expect(
        psql(`SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE proname = '${f}'`),
      ).toBe('partition_owner:true:search_path="",lock_timeout=5s');
    for (const f of SWEEP_DEFINER_FUNCTIONS_6C)
      expect(psql(`SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text FROM pg_proc WHERE proname = '${f}'`)).toBe('sweep_definer:true');
    expect(psql(`SELECT count(*) FROM webhook_event_types WHERE type LIKE 'tenancy.%'`)).toBe('6');
    expect(psql(`SELECT string_agg(key, ',' ORDER BY key) FROM permissions WHERE key LIKE 'webhooks.%'`)).toBe('webhooks.read,webhooks.write');
  });

  it('X-4: changing a member role reaches the HTTPS receiver in the compose network, signed; the delivery is SUCCEEDED', async () => {
    compose(['up', '-d', '--wait', '--no-deps', 'webhook-receiver'], { timeoutMs: 120_000 });
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const org = await device.call('POST', '/v1/orgs', { body: { name: 'Smoke 6C' }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(org.status).toBe(201);
    const { id: orgId } = z.object({ id: z.uuid() }).parse(await org.json());
    // Member seed bằng superuser (mẫu smoke 3B): một user đã xác thực khác, role MEMBER.
    const { email: memberEmail } = await verifiedDevice(apiUrl, mail, forbidden);
    const authId = psql(`SELECT id FROM auth."user" WHERE email = '${memberEmail}'`);
    psql(`INSERT INTO tenancy_users (auth_user_id) VALUES ('${authId}') ON CONFLICT (auth_user_id) DO NOTHING`);
    psql(
      `INSERT INTO org_members (org_id, user_id, role_id) SELECT '${orgId}', u.id, r.id FROM tenancy_users u, org_roles r
       WHERE u.auth_user_id = '${authId}' AND r.org_id = '${orgId}' AND r.system_key = 'MEMBER'`,
    );
    const memberId = psql(
      `SELECT m.public_id FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE m.org_id = '${orgId}' AND u.auth_user_id = '${authId}'`,
    );
    const adminRole = psql(`SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'ADMIN'`);
    const created = await device.call('POST', `/v1/orgs/${orgId}/webhook-endpoints`, {
      body: { url: 'https://webhook-receiver/hook', eventTypes: ['tenancy.member.role_changed'] },
    });
    expect(created.status).toBe(201);
    const endpoint = z.object({ id: z.uuid(), secret: z.string() }).parse(await created.json());
    forbidden.push(endpoint.secret, endpoint.secret.slice('whsec_'.length));
    const changed = await device.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, { body: { roleId: adminRole }, headers: { 'if-match': '*' } });
    expect(changed.status).toBe(200);
    const until = Date.now() + DELIVERY_WAIT_MS;
    let got = received();
    while (got.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      got = received();
    }
    const [req] = got;
    expect(req?.path).toBe('/hook');
    const header = (k: string) => String(req?.headers[k] ?? '');
    const payload = new Webhook(endpoint.secret).verify(req?.body ?? '', {
      'webhook-id': header('webhook-id'),
      'webhook-timestamp': header('webhook-timestamp'),
      'webhook-signature': header('webhook-signature'),
    });
    expect(payload).toMatchObject({ type: 'tenancy.member.role_changed', version: 1, data: { memberId } });
    forbidden.push(header('webhook-signature').split(',')[1] ?? '');
    const list = await device.call('GET', `/v1/orgs/${orgId}/webhook-endpoints/${endpoint.id}/deliveries`);
    expect(z.object({ data: z.array(z.object({ status: z.string() })) }).parse(await list.json()).data.map((d) => d.status)).toEqual(['SUCCEEDED']);
  });

  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without the secret or the signature', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), forbidden.filter((v) => v.length > 0));
  });
});
```
(Route `PATCH /v1/orgs/:orgId/members/:memberId` với `{ roleId }` và `If-Match: *` theo đúng smoke 3B (`tenancy.smoke.spec.ts:387-393`). `webhook-receiver` chỉ được dựng ở ca này; `down -v --remove-orphans` của teardown dọn nó.)

- [ ] **Step 3: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; migrate từ `dist` gồm `…_webhooks`; mọi file smoke có sẵn PASS (`core`, `auth-email`, `dashboard`, `tenancy`, `core-shared`, `composition`, `entitlements`) cộng `integrations.smoke.spec.ts`; log JSON không `error`; teardown `down -v` sạch.

- [ ] **Step 4: Đo image, ghi ADR 0013**

Run:
```bash
docker history --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
docker image inspect --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
```
`docs/adr/0013-build-toolchain.md`: thêm mục sau mục số đo mới nhất (cùng phương pháp: tổng layer `docker history`; nén = `docker image inspect`), số là **dữ liệu đo** của lần chạy Step 3:
```markdown
### Số đo SP6 (6C) (<ngày chạy, YYYY-MM-DD>)

Đo sau `pnpm test:smoke` xanh của Task 18 plan 6C (image `nestjs-saas-boilerplate:nsb-smoke`), cùng máy và phương pháp với dòng mới nhất ở trên. 6C thêm một package runtime: `standardwebhooks` 1.1.1 (cùng `@stablelib/base64`, `fast-sha256`). Thay đổi còn lại là code của `integrations`, một migration và `core/http/openapi.ts`.

| Chỉ số | <dòng mới nhất ở trên> | SP6 (6C) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | <số của dòng trên> | <số đo> | <chênh> |
| Image nén | <số của dòng trên> | <số đo> | <chênh> |
| Layer `dist` | <số của dòng trên> | <số đo> | <chênh> |
| Mốc ≤ 400 MB chưa nén (§13.3) | <trạng thái của dòng trên> | <ĐẠT/KHÔNG, dư … MB> | |
```
Các ô trong ngoặc là số đo thật của lần chạy (không phải chỗ trống của plan). Vượt 400 MB chưa nén → dừng, báo Sếp (spec §20.1: không tối ưu trước khi có số đo).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write test/smoke/integrations.smoke.spec.ts test/smoke/smoke-app-env.ts test/smoke/compose.smoke.yaml
git add test/smoke/integrations.smoke.spec.ts test/smoke/webhook-receiver.mjs test/smoke/compose.smoke.yaml test/smoke/gen-certs.sh test/smoke/smoke-app-env.ts docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): webhook schema from dist and a signed webhook to an HTTPS receiver on the production image; record the 6C image size"
```

---

### Task 19: Tài liệu — ADR 0020 (phần Webhooks), 0006, 0016, 0005; README; spec cha, SP3, SP6 (lệch có chủ đích của 6C)

**Files:**
- Modify: `docs/adr/0020-files-audit-webhooks.md`, `docs/adr/0006-queue-outbox.md`, `docs/adr/0016-outbound-http-ssrf.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/boilerplate/README.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, `docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md`

**Interfaces:**
- Consumes: mọi tên, mã lỗi, metric, số đo của Task 1–18 (W2, W3, `webhook_partitions_maintain_ms`, `webhook_w46`, kích thước image).
- Produces: tài liệu khớp code.

- [ ] **Step 1: ADR 0020 — phần Webhooks**

`docs/adr/0020-files-audit-webhooks.md`: thêm mục sau "Kết quả spike (plan 6C)":
```markdown
## Webhooks (plan 6C, <ngày merge>)

- **Dữ liệu (S6-A27, S6-A29):** `webhook_event_types` (bảng tra cứu, FK RESTRICT), `webhook_endpoints`, `webhook_endpoint_secrets`
  (`FieldCipher`, AAD `webhook_endpoint_secrets:secret_enc:<orgId>:<publicId>`, tối đa một secret hiện hành, tối đa hai secret còn
  ký), `webhook_endpoint_event_types`, và hai bảng partitioned của `partition_owner`: `webhook_messages` (body tuần tự hoá một lần,
  ký nguyên văn) và `webhook_deliveries` (một dòng mỗi message × endpoint, `UNIQUE (org_id, message_id, created_at, endpoint_id)`).
  Bảng partitioned không FK tới `organizations` (R-X27) hay bảng thường nào (R-X33, spike W3: `DETACH` + `DROP` lấy
  `AccessExclusiveLock` trên bảng được tham chiếu): `webhook_deliveries` không FK tới `webhook_endpoints`; fan-out giữ dòng endpoint
  `FOR KEY SHARE`, sweep xoá cứng giữ `FOR UPDATE` rồi kiểm `NOT EXISTS` bằng câu riêng; test bất biến "mọi delivery có endpoint"
  (`orphanDeliveries`). `partition_owner` không có REFERENCES trên bảng thường nào.
- **Bảo trì partition:** `webhook_partitions_maintain` (lockKey 6002, sàn 1 tháng, drop deliveries trước messages cùng tháng, P2).
  Một lượt hai bảng đo được <webhook_partitions_maintain_ms> ms, dưới `statement_timeout` 5 s của `app_user` (ngân sách P1).
- **Gửi (S6-A28, S6-A34):** Standard Webhooks (`webhook-id` = event id, `webhook-timestamp` giây Unix lúc gửi, chữ ký mọi secret còn
  hiệu lực cách dấu cách). Claim: khoá dòng endpoint, đếm in-flight, rồi CAS + lease + `attempts_total + 1`; job
  `webhook-<id>-a<n>` (n chưa từng claim), `-k<ms>` kiểm lại khi kill switch bật, `-b<ms>` khi endpoint đủ in-flight, `-s<slot>`
  cho sweep enqueue lại. Job tới sớm hơn `next_attempt_at` quá 1 s là no-op; dời (kill switch, bận) dùng
  `GREATEST(next_attempt_at, now + delay)` và chỉ khi đã đến hạn. Ghi kết quả là CAS có fencing
  `status = 'SENDING' AND attempts_total = n`; kết quả bị fence không chạm endpoint.
- **Phân loại (S6-A49, R-X35):** `classifyAttempt`; lỗi của ta (`BULKHEAD_FULL`, `CIRCUIT_OPEN`, `LEASE_EXPIRED`,
  `SECRET_UNAVAILABLE`) không tiêu lịch (`cycle_base + 1`), không chạm `failing_since`, nhưng có đếm (`local_failures`); lần thứ
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
  `webhooks-bulkhead-covers-concurrency`). Một endpoint chậm (timeout <ms>) với <n> delivery chờ: endpoint khoẻ xong sau <healthyMs> ms,
  SENDING của endpoint chậm tối đa <maxSending> (W-46, cận tính được <bound> ms).
- **Catalog (R-X30):** code có mà DB thiếu → không khởi động; DB có mà code không biết → WARN + `webhook_event_types_unknown_to_code_total`.
- **OpenAPI (S6-A36):** mục `webhooks` của `openapi.json` (khoá `<type>@<version>`), so bằng <oasdiff | webhook-contract.spec.ts> theo W2.
- **Purge:** participant `integrations` order 120, chỉ DB; trong rollout, worker cũ chưa có participant gặp `23001` và BullMQ retry.
```
Các ô `<…>` là số đo/kết luận thật của Task 1, 3, 17, không phải chỗ trống.

- [ ] **Step 2: ADR 0006, 0016, 0005**

`docs/adr/0006-queue-outbox.md`: thêm mục cuối:
```markdown
## Cập nhật SP6 (6C) (<ngày merge>)

- Subscriber bộ chọn đầu tiên của module: `integrations.webhook-fanout` (`WEBHOOK_EVENTS`), chạy trong `UnitOfWork` + `Inbox.once`
  của deliver, chỉ ghi DB + `SafeEnqueue` (outbox).
- Dead-letter của webhook là trạng thái trong DB (`EXHAUSTED`/`CANCELLED`), không phải tập failed của BullMQ; tập failed chỉ còn
  cho lỗi lập trình (vd. endpoint không có secret nào). Secret không giải mã được (`FieldCipherError`, kid bị retire sai) là lỗi của
  ta có đếm (R-X35): delivery `EXHAUSTED` sau `INTEGRATIONS_MAX_LOCAL_FAILURES` lần, log ERROR `webhook_secret_unreadable`.
- Lịch retry là job mới có `delayMs` (không backoff của BullMQ); jobId theo số lần claim nên không bao giờ bị BullMQ bỏ qua vì trùng.
```
`docs/adr/0016-outbound-http-ssrf.md`: thêm mục cuối:
```markdown
## Cập nhật SP6 (6C) (<ngày merge>)

- URL của tenant (webhook) đi qua hai lớp: `UrlGuard` lúc tạo/sửa (cùng `assertUrlAllowed`, mọi địa chỉ phân giải phải công khai
  hoặc trong `RESILIENCE_SSRF_ALLOW_CIDRS`; chỉ để phản hồi sớm `422`) và `ssrfLookup` lúc connect của `HttpClient` (lớp chặn thật,
  chống DNS rebinding, W-22).
- Provider `webhooks-out`: `setProviderDefaults` lúc DI của worker với `retries: 0`, breaker tắt (`breakerThreshold =
  Number.MAX_SAFE_INTEGER`), timeout `INTEGRATIONS_WEBHOOK_TIMEOUT_MS`, bulkhead `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT`/`_QUEUE`.
  Breaker theo provider sẽ gộp endpoint của mọi khách; sức khoẻ theo endpoint nằm ở DB.
- 3xx không được theo (`REDIRECT`); 429 dùng `Retry-After` đã chặn trần làm sàn của bước lịch.
```
`docs/adr/0005-multi-tenant-rls.md`: thêm mục cuối:
```markdown
## Cập nhật SP6 (6C) (<ngày merge>)

- Năm bảng tenant mới (RLS + FORCE, policy `TO app_user` trên `org_id`): `webhook_endpoints` (FK RESTRICT tới `organizations`),
  `webhook_endpoint_secrets`, `webhook_endpoint_event_types` (FK kép tới endpoint), `webhook_messages`, `webhook_deliveries`
  (partitioned, không FK tới `organizations`, R-X27; dọn bằng participant `integrations`). `webhook_event_types` là bảng global.
- `sweep_definer`: `SELECT` theo cột + policy `_definer_read` trên `webhook_endpoints`, `webhook_deliveries`; hàm
  `integrations_orgs_due(p_after, p_limit, p_grace_sec)` chỉ trả id org.
- `partition_owner` sở hữu hai bảng partitioned và `webhook_partitions_maintain`; không có REFERENCES trên bảng thường nào
  (R-X33: không FK partitioned → bảng thường; luật catalog trong `rls-catalog.spec.ts`).
```

- [ ] **Step 3: README**

`docs/boilerplate/README.md`: thêm mục mới "### Webhook ra ngoài (integrations)" sau mục của module gần nhất (đọc file để đặt đúng chỗ):
```markdown
### Webhook ra ngoài (integrations)

- **Bật/tắt:** module `integrations` (cần `tenancy`); tắt bằng `disable: ['integrations']` trong `src/app.modules.ts`. Migration
  vẫn chạy (bảng rỗng); quyền `webhooks.*` còn trong DB là quyền mồ côi (R-X21, chỉ WARN).
- **Quyền:** `webhooks.read` (ADMIN, org API key, support grant) và `webhooks.write` (ADMIN; không dùng được bằng org API key hay
  support grant). Thêm hai quyền làm `perms(ADMIN)` lớn lên: role tuỳ biến từng tương đương ADMIN không còn tương đương.
- **Đăng ký:** `POST /v1/orgs/{orgId}/webhook-endpoints` cần session mới và email đã xác thực; URL phải là `https` công khai
  (không IP nội bộ, không userinfo, không fragment, cổng thuộc `RESILIENCE_ALLOWED_PORTS`). Secret `whsec_…` chỉ trả một lần
  (và một lần nữa ở mỗi `rotate-secret`). Tối đa `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG` endpoint mỗi org.
- **Đổi đích (R-X34):** đổi `url` hoặc `eventTypes` là `PATCH …/webhook-endpoints/{id}/destination` — cùng điều kiện với tạo
  (session của người, mới, email đã xác thực; API key không dùng được). `PATCH …/webhook-endpoints/{id}` chỉ đổi `description` và
  `status` (gửi `url`/`eventTypes` ở đây là `422`).
- **Xác minh ở phía khách:** Standard Webhooks; ví dụ Node: `new Webhook(secret).verify(rawBody, { 'webhook-id', 'webhook-timestamp',
  'webhook-signature' })` của package `standardwebhooks`. Trong `INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC` sau một lần xoay, header có
  hai chữ ký: secret cũ hoặc mới đều verify được. Dùng `webhook-id` để chống xử lý trùng (cùng event có thể tới nhiều lần).
- **Retry:** lịch `INTEGRATIONS_RETRY_SCHEDULE_SEC` (mặc định 8 lần thử trong ~27,5 giờ, ±10%); `429` có `Retry-After` được tôn
  trọng (có trần); 3xx không được theo. Hết lịch → `EXHAUSTED` + event `integrations.delivery.exhausted`; gửi lại bằng
  `POST …/webhook-deliveries/{id}/retry` hoặc `POST …/webhook-endpoints/{id}/recover { since }`. Endpoint lỗi liên tục quá
  `INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC` bị tắt (`AUTO_FAILING`); bật lại bằng `PATCH { status: 'ACTIVE' }` rồi `recover`.
- **Catalog:** `GET /v1/webhook-event-types` (JSON Schema của từng payload); mục `webhooks` của `openapi.json`. Event `webhook: true`
  là hợp đồng công khai: đổi payload phải lên version.
- **Vận hành:** kill switch `integrations.webhook_delivery` dừng mọi request ra ngoài (delivery chờ, chạy lại khi tắt). Cảnh báo:
  `webhook_local_faults_total > 0` kéo dài (lỗi của ta, không phải của khách), tỉ lệ `webhook_deliveries_exhausted_total` tăng vọt,
  `db_partition_months_ahead{table="webhook_deliveries"} < 2`. Dữ liệu giữ `INTEGRATIONS_DELIVERY_RETENTION_MONTHS` tới +1 tháng (drop
  theo partition tháng trọn).
- **Lỗi của ta có trần (R-X35):** bulkhead đầy, breaker, worker chết giữa lúc gửi (lease hết hạn), secret không giải mã được không
  tiêu lịch và không làm hỏng sức khoẻ endpoint, nhưng lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` (mặc định 5) đưa delivery về
  `EXHAUSTED`; sửa nguyên nhân rồi `retry`/`recover` (bộ đếm về 0).
- **Endpoint chậm không chiếm hết worker (R-X35):** mỗi endpoint tối đa `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` (mặc định 4,
  phải < `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT`) request đang bay; phần còn lại được hẹn lại sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC`,
  không tính là lỗi. Rủi ro còn lại: trần theo endpoint, không theo org — một org có nhiều endpoint chết vẫn chiếm
  `N × số endpoint` slot (giới hạn bởi `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG` và tự tắt endpoint). Endpoint bận sinh một job hẹn lại mỗi
  delivery chờ mỗi `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC`: hàng nghìn delivery chờ một endpoint chết là hàng nghìn job ngắn mỗi chu kỳ
  tới khi endpoint tự tắt.
- **Bộ nhớ worker (M9):** tệ nhất `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT × RESILIENCE_MAX_RESPONSE_BYTES` (20 × 10 MB ≈ 200 MB) cho body
  response webhook mỗi process; hạ `RESILIENCE_MAX_RESPONSE_BYTES` nếu worker chật RAM. Trần riêng cho `webhooks-out` là việc sau.
- **Sweep khi phục hồi sự cố (M5):** mỗi lượt sweep một org enqueue lại tối đa `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG` (mặc định 100)
  delivery mất job, cùng trần cho lease hết hạn và xoá cứng endpoint. Mất Redis với 10 000 delivery chờ của một org cần ~100 lượt
  (cron 5 phút ≈ 8 giờ) để enqueue lại hết; delivery đã lấy được "chạm" `next_attempt_at` nên lượt sau lấy phần còn lại, không lấy
  lại cùng dòng. Tăng env tạm thời khi phục hồi.
- **Xoay khoá `FieldCipher`:** secret ký mã hoá bằng keyring `FIELD_ENCRYPTION_KEYS`; trước khi retire một kid phải mã hoá lại mọi
  `webhook_endpoint_secrets.secret_enc` của kid đó (runbook của SP7). Không làm thì mỗi delivery của endpoint đó ghi
  `SECRET_UNAVAILABLE` (log ERROR `webhook_secret_unreadable`) và thành `EXHAUSTED` sau `INTEGRATIONS_MAX_LOCAL_FAILURES` lần; thêm kid
  cũ lại vào keyring rồi `recover`.
- **Helm/egress (SP7 7B):** worker cần egress tới internet trên `RESILIENCE_ALLOWED_PORTS`; tách queue `webhooks-out` ra nhóm worker
  riêng thì thêm nó vào `default.queuesExclude`. `bulkheadLimit` phải ≥ concurrency của `webhooks-out` (luật config chặn lúc boot).
- **Nâng cấp lên 6C (một PR, không tách expand/contract — phán quyết đã chốt):** chạy migrate Job trước rollout (code có mà DB thiếu
  dòng `webhook_event_types` thì không khởi động). Trong lúc rollout (M6), pod cũ và mới cùng chạy:
  - worker cũ xử lý `core.event.dispatch` của một event webhook: `SubscriberRegistry` cũ không có `integrations.webhook-fanout`, nên
    không có job fan-out cho event đó — **bỏ qua trong im lặng**, event đó không bao giờ thành webhook (`event-dispatch.handlers.ts`:
    "event has no subscribers" chỉ ở mức debug);
  - worker cũ nhận job fan-out (`core.event.deliver`, consumer `integrations.webhook-fanout`) hay job hoãn `integrations.*` do pod mới
    tạo: ném `Subscriber "integrations.webhook-fanout" is not registered in this worker` / `Deferred job "…" is not registered`,
    BullMQ retry tới khi worker mới nhận (hết lượt retry thì vào tập failed: chạy lại tay);
  - worker cũ chưa có participant `integrations` gặp `23001` khi purge một org đã có endpoint: BullMQ retry, worker mới purge được.
  Phán quyết "một PR, không tách" giữ nguyên: endpoint chỉ tạo được qua api mới, nên trước khi org nào có endpoint thì bỏ qua là vô
  hại. Muốn không mất fan-out nào: rollout worker xong rồi mới cho khách tạo endpoint.
```

- [ ] **Step 4: Spec cha, SP3, SP6**

`docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` — chỉ sửa nếu 6.0 chưa áp các dòng của SP6 §18.1 về webhook (kiểm bằng `grep -n "dead-letter\|webhooks" <file>`): §6 dead-letter thành "Webhook: dead-letter là delivery `EXHAUSTED`/`CANCELLED` trong DB (có API replay); tập failed của BullMQ cho lỗi lập trình"; §14 Contract thêm "Schema webhook ra ngoài nằm trong mục `webhooks` của OpenAPI 3.1 và được `oasdiff` kiểm".

`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` — §23.2 câu 2 (chỉ nếu chưa có): "thông báo khi bị xoá khỏi org được phục vụ bằng webhook (`tenancy.member.removed`, 6C) và audit (6B), không làm in-app (L7)".

`docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md` — thêm đoạn cuối mục 23:
```markdown
Sửa theo plan 6C (lệch có chủ đích, lý do ở plan; các sửa từ review plan 6C — R-X33, R-X34, R-X35, §7.3 `23001`, §10 sweep-org `run`,
§11.4 env mới — đã nằm trong thân spec từ commit "SP6 amendments from the 6C plan review"): `webhook_messages` không FK tới
`organizations` (R-X27, ghi đè §6.4/§6.5 "Neo org" cho bảng partitioned); thêm `UNIQUE (org_id, message_id, created_at, endpoint_id)`
của `webhook_deliveries` (một delivery mỗi message × endpoint) thay index `(org_id, message_id, …)` riêng; index danh sách delivery
`(org_id, endpoint_id, created_at DESC, public_id DESC)` (cursor không lộ id nội bộ); kiểm catalog event type chịu dòng chỉ có ở DB
(R-X30, §6.5 "Lệch → không khởi động" chỉ còn cho chiều code có mà DB thiếu); `failing_since` không tăng `version`;
`GET /v1/webhook-event-types` trả `{ data }` không phân trang (§20.2 (9)); X-4 smoke dùng `tenancy.member.role_changed` qua member seed
bằng superuser.
```

- [ ] **Step 5: Kiểm và commit**

Run:
```bash
pnpm exec prettier --check docs/boilerplate/README.md || true
git diff --stat docs
```
Expected: chỉ các file trên đổi.
```bash
git add docs/adr docs/boilerplate/README.md docs/superpowers/specs
git commit -m "docs(integrations): webhooks in ADR 0020/0006/0016/0005, the README section, and the 6C deviations in the parent, SP3 and SP6 specs"
```

---

### Task 20: Kiểm chứng toàn nhánh — sẵn sàng cho PR (controller push và mở PR)

**Files:** không sửa file nào ngoài lỗi mà bước kiểm phát hiện (mỗi lỗi sửa ở task gốc, commit riêng).

- [ ] **Step 1: Merge `main` mới nhất (không rebase), kiểm timestamp migration**

Run:
```bash
git fetch origin
git merge origin/main
ls src/migrations/integrations
pnpm vitest run --project unit test/unit/migrations
```
Expected: merge sạch; xung đột văn bản với 6A/7B/4C (danh sách ở Self-review mục 9) giải theo luật ghi ở đó, rồi chạy lại mọi bước dưới. `…_webhooks` có timestamp lớn hơn mọi migration của vùng boilerplate trên `main`; nếu không: sinh lại bằng CLI (`migration:create --blank --path src/migrations/integrations --name webhooks`), chép thân, xoá file cũ, chạy lại Task 2–3. Nếu 6A đã merge trong lúc làm mà chưa mang dòng `files.file.*` của `webhook_event_types`: làm Task 2 Step 6.

- [ ] **Step 2: Kiểm tĩnh**

Run:
```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm arch
pnpm vitest run --project unit
node tools/upstream/check.mjs --self
pnpm env:example && git diff --exit-code .env.example
pnpm build && pnpm openapi:export && git diff --exit-code openapi.json
git diff origin/main --stat -- package.json pnpm-lock.yaml .upstream/zones.json
git diff origin/main --name-only | grep -F "src/modules/tenancy/domain/acquisition-token.ts" || echo "no accepted CodeQL finding moved"
```
Expected: mọi lệnh xanh; `hardcode-scan.spec.ts`, `migration-scan.spec.ts`, `migration-order.spec.ts`, `event-flags.spec.ts`, `cron-queue.spec.ts` xanh; `upstream:check --self` xanh (mọi file mới dưới tiền tố đã phân vùng; `zones.json` không đổi); `.env.example`, `openapi.json` khớp commit; diff `package.json`/`pnpm-lock.yaml` chỉ có `standardwebhooks` (và hai phụ thuộc của nó); không file nào trong `.github/codeql/accepted-findings.txt` bị sửa.

- [ ] **Step 3: Test có DB, chaos, prod-like**

Run:
```bash
pnpm test:int
pnpm test:chaos
pnpm test:smoke
```
Expected: mọi project xanh (`integration` gồm `test/e2e/**`). Chạy thêm hai lần `test/e2e/integrations/deliver-races.e2e.spec.ts`, `test/e2e/integrations/endpoints-create.e2e.spec.ts` (ca R6-26) và `test/e2e/integrations/deliveries.e2e.spec.ts` (ca R6-14): race ép bằng barrier phải xanh ổn định; ghi thời gian chạy vào mô tả PR.

- [ ] **Step 4: Rà diff lần cuối**

Run:
```bash
git log --oneline origin/main..HEAD
git diff origin/main --stat
grep -rn "TODO\|FIXME\|it.only\|describe.only\|as any\|eslint-disable\|oxlint-disable" $(git diff origin/main --name-only -- src test) || true
git grep -n "modules/files\|modules/admin\|modules/audit" -- src/modules/integrations || true
git ls-files test/integration/spike-sp6c
```
Expected: mỗi task có ít nhất một commit conventional; không `TODO`/`.only`/`as any`/tắt lint mới; integrations không import files/admin/audit; không file spike nào được track. CodeQL của CI có finding mới trên `src/modules/integrations/**` (vd. `js/request-forgery` ở `deliver-webhook.handler.ts` vì URL đến từ DB) → kiểm tay: nếu là false positive (URL đã qua `UrlGuard` lúc ghi và `ssrfLookup` lúc connect), thêm dòng `<ruleId> <path>:<line>` kèm lý do kiểm tay vào `.github/codeql/accepted-findings.txt` ở commit riêng; nếu là lỗi thật, sửa ở task gốc.

- [ ] **Step 5: Sẵn sàng cho PR**

Nhánh đã merge `origin/main`, mọi kiểm ở Step 1–4 xanh trên máy local. Mô tả PR (controller dùng): nội dung theo task, lệnh kiểm chứng và kết quả thật, số đo (image ADR 0013, W-46, bảo trì partition), kết luận spike W1–W3, nhánh W2 đã chọn, trạng thái nhánh "6A đã merge" của Task 2 Step 6. **Dừng ở đây**: không push, không mở PR — controller push nhánh, mở PR "SP6 6C: outbound webhooks" và chờ mọi job CI xanh (race/timing chạy trên Linux CI).

---
## Chỗ đụng code của plan trước và lệch có chủ đích

**Code của plan trước mà 6C sửa:** `src/core/http/openapi.ts` (mục `webhooks`, Task 16); `src/core/logging/redaction.ts` (Task 5); `src/boilerplate.modules.ts`, `src/boilerplate.module-keys.ts` (Task 13); `.dependency-cruiser.cjs` (luật 21, bỏ ngoại lệ `no-orphans` của `admin-readers.ts`; Task 1, 6); test support `core-catalog.ts` (hằng `_6C`), `tenancy-seed.ts` (`PURGE_ORDER`), `test/unit/composition/compose.spec.ts`, `test/unit/architecture/rules.spec.ts`, `test/unit/core/logging/redaction.spec.ts`, `test/integration/core/database/{rls-catalog,normalization-inventory}.spec.ts` (thêm ca R-X33 "không FK partitioned → bảng thường"); smoke `compose.smoke.yaml`, `gen-certs.sh`, `smoke-app-env.ts`; `renovate.json`, `package.json`, `pnpm-lock.yaml`. Không đổi code nào của tenancy, identity, notifications, entitlements.

**Lệch có chủ đích (mỗi dòng có lý do ở task; Task 19 ghi vào spec SP6; các mục từ review plan 6C đã sửa thẳng vào spec SP6 bằng commit `docs(spec): SP6 amendments from the 6C plan review`):**
1. `webhook_messages` không FK tới `organizations` (R-X27, mới hơn spec r2 §6.5).
2. `UNIQUE (org_id, message_id, created_at, endpoint_id)` của `webhook_deliveries`: bất biến "một delivery mỗi message × endpoint" ở DB, đồng thời là index cho FK RESTRICT khi xoá message (thay index riêng).
3. Index danh sách delivery theo `public_id DESC` thay `id DESC`: cursor không lộ id BIGINT nội bộ.
4. `INTEGRATIONS_PARTITION_PREMAKE_MONTHS` (3) thêm vào §11.4 (không hard code số tháng).
5. Kiểm catalog event type chịu dòng chỉ có ở DB (R-X30) thay "lệch → không khởi động" hai chiều.
6. `failing_since` (đặt/xoá) không tăng `version`; tự tắt có tăng.
7. **(R-X33, đã vào spec)** Không FK `webhook_deliveries → webhook_endpoints`: người ghi (fan-out) giữ `FOR KEY SHARE OF e`; người xoá cứng (sweep) giữ `FOR UPDATE OF e SKIP LOCKED` rồi kiểm `NOT EXISTS` bằng câu riêng sau khi có khoá; bất biến "mọi delivery có endpoint" có test (`orphanDeliveries`). Spec §7.3 cũ dựa vào lỗi FK (`23503`, đúng ra là `23001`) — không còn FK nên không còn lỗi đó.
8. Claim có điều kiện `next_attempt_at <= clock_timestamp() + CLAIM_CLOCK_SKEW_MS` (R6C-1): job trùng hoặc tới sớm là no-op.
9. `GET /v1/webhook-event-types` trả `{ data }` không phân trang (mẫu `GET /v1/permissions`; spec §20.2 (9) giả định `Paginator.offset`).
10. Mục `webhooks` của OpenAPI dựng từ registry event của core, không phụ thuộc module integrations có bật hay không (cờ `webhook` là hợp đồng của module phát event).
11. Kết quả bị fence không chạm endpoint (`markFailing`/`autoDisable` chạy sau CAS kết quả thành công).
12. X-4 dùng `tenancy.member.role_changed` với member seed bằng superuser (mẫu smoke 3B).
13. **(R-X34, đã vào spec)** Đổi `url`/`eventTypes` là route riêng `PATCH …/:endpointId/destination` có `@SessionOnly()` + `@RequireFreshSession()` + `@RequireVerifiedEmail()`; `PATCH …/:endpointId` chỉ còn `description`, `status`.
14. **(R-X35, đã vào spec)** Lỗi của ta có trần `INTEGRATIONS_MAX_LOCAL_FAILURES` (cột `local_failures`, `last_error` mới `SECRET_UNAVAILABLE`); bulkhead in-flight theo endpoint `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT`.
15. **(I4, đã vào spec)** `integrations.sweep-org` là `onInactiveOrg: 'run'` (spec §10 ghi `skip`).
16. **(M5, M7)** Env `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG`; trần cứng `WEBHOOK_EVENT_TYPES_MAX = 50` cho schema/OpenAPI, env `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT` chỉ hạ lúc chạy.
17. **(M4)** Down của migration `…_webhooks` từ chối khi còn endpoint hoặc secret (mẫu down có canh của 3B/4B).

---

## Self-review (chạy lại sau review plan 6C)

### 1. Phủ spec (mọi hạng mục spec giao cho 6C)

| Hạng mục spec | Task |
|---|---|
| §4 spike W1 (giữ thành test hợp đồng) | 1 |
| Spike thêm: W2 oasdiff trên `webhooks` (giả định S6-A36); W3 khoá FK partitioned → bảng thường (kết quả đã đo, R-X33; không phải cổng) | 1 |
| §6.5 `webhook_event_types` (+6 dòng tenancy), `webhook_endpoints`, `…_secrets`, `…_event_types`, `webhook_messages`, `webhook_deliveries` (+ `local_failures`, không FK tới endpoint); grant theo cột; policy `_definer_read` | 2 |
| R-X33 luật catalog "không FK partitioned → bảng thường" + bất biến "mọi delivery có endpoint" | 2, 3, 10, 11, 15 |
| §6.7 `webhook_partitions_maintain` (sàn 1, lockKey 6002, drop deliveries trước messages), partition đầu | 2, 3 |
| §6.8 `integrations_orgs_due` (`p_grace_sec` theo tên, R-X14) | 2, 3, 5 |
| §6.9 chuẩn hoá 6 bảng; X-2 `normalization-inventory` | 2 |
| §6.10 migration 6C + quyền `webhooks.*`; Bảng 4 (dòng `files.file.*` khi 6A merge trước); down có canh (M4) | 2 |
| §5.3 (c)(d) `rls-catalog`: `GLOBAL_TABLES` + hằng 6C; partition owner/grant; tập definer chính xác | 2 |
| Tiêu chí 1 (RLS 5 bảng, partition không grant) W-42 | 3 |
| W-44, R6-17 bảo trì partition | 3 |
| §7.2 máy trạng thái delivery (+ `DEFER`, `localFailures`), `classifyAttempt` (+ `SECRET_UNAVAILABLE`), `localRetryLeft` (W-34 unit, R-X35) | 4 |
| §7.3 máy trạng thái endpoint | 4, 9, 11 |
| §7.4 secret xoay có chồng lấn, tối đa hai | 7, 9 |
| §8.3 body tuần tự hoá một lần, `WEBHOOK_BODY_MAX_BYTES` | 4, 10 |
| §8.3 bước 4 ánh xạ kết quả HTTP → `last_error` | 4, 11 |
| §11.4 config (+ `INTEGRATIONS_MAX_LOCAL_FAILURES`, `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT`, `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG`, `INTEGRATIONS_PARTITION_PREMAKE_MONTHS`) + luật `webhooks-bulkhead-covers-concurrency` + in-flight < bulkhead | 5 |
| §9.4 lỗi integrations; đăng ký constraint → lỗi (có test duplicate-throw) | 5 |
| §10 queue `webhooks-out`, job deliver/sweep-org (`run`, I4)/sweep-orgs, cron | 5, 11 |
| §10 event `integrations.*` (audit true, webhook false, R-X3) | 5 |
| Kill switch `integrations.webhook_delivery` (tiêu chí 11, W-45; dời không kéo sớm — M1) | 5, 11 |
| `definePartitionedTable` của hai bảng | 5 |
| §9.1 catalogue `webhooks.read`/`webhooks.write` (không apiKey cho write, S6-A35) | 5, 14 |
| §5.3 redact `webhookSecret`, `secretEnc` | 5 |
| §6.5 kiểm catalog lúc boot (R-X30) | 6 |
| R-X16: `markModuleLoaded` (Task 6); `BOILERPLATE_MODULES`, `MODULE_REQUIRES integrations → tenancy`, X-9 (Task 13, sau khi mọi `@JobHandler` có ở Task 11) | 6, 13 |
| §5.4 luật 21 (+ fixture), luật 25 (fixture) | 1 |
| §8.3 bước 1 `UrlGuard` (W-20, W-21, Review Focus 1–2) | 7, 8 |
| §8.3 ký Standard Webhooks (W-1…W-4) | 7, 11, 18 |
| §8.3 "Đăng ký" + giới hạn dưới khoá org (R6-26), secret một lần, event `created` chỉ host; trần event type lúc chạy (M7); thứ tự byte (M3) | 8 |
| §9.2 route GET/POST/PATCH/PATCH `destination` (R-X34)/DELETE endpoint, rotate-secret, `GET /v1/webhook-event-types` | 8, 9 |
| §8.3 "Fan-out" (R6-15, W-40, `FOR KEY SHARE` R-X33), `WebhookStatsReader` (R-X16) | 10 |
| §8.3 "Gửi": claim/lease/fencing, bulkhead in-flight (R-X35), lịch, hết lịch + event, trần lỗi của ta, tự tắt, 429/3xx/4xx/5xx/too_large, SSRF lúc gửi (W-10, W-11, W-14, W-15, W-22…W-24), R6-10, R6-25 | 11 |
| §5.3 `setProviderDefaults('webhooks-out')` (S6-A30) | 11 |
| W-34 phần integration (bulkhead_full ×(N−1) giữ lịch, lần N `EXHAUSTED`); secret không giải mã được ×N | 11 |
| §8.3 "Sweep" (job mất có trần mỗi org — M5, lease hết hạn LEASE_EXPIRED ×N → `EXHAUSTED`, xoá cứng endpoint dưới khoá) | 11 |
| R6-9 (W-31), R6-11, R6-12 (W-32) | 12 |
| W-30 chaos giết worker | 13 |
| §8.3 "Dead-letter" retry/recover (đặt lại `local_failures`), "Gửi thử", list cursor, GET delivery (W-12, W-13, W-16, W-33, R6-13, R6-14) | 14 |
| G-6 phủ route mới (12 route); ca org key không tạo/đổi đích endpoint (cặp 3D/6C) | 14 |
| §8.3 "Xoá cứng org" participant 120 (W-41), X-3 | 15 |
| §8.3 "Hợp đồng công khai" mục `webhooks` OpenAPI + oasdiff (W-43); `maxItems` không phụ thuộc env (M7) | 8, 16 |
| Tiêu chí 13 (DB lỗi → 503) cho 6C | 17 |
| W-46 (số đo, + `maxSending` ≤ trần in-flight) | 17 |
| X-7 (không PII; body webhook đã nhận và body response receiver nằm trong tập cấm — M2) | 17 |
| X-4 smoke HTTPS, X-6 đo image (ADR 0013) | 18 |
| §18.5 ADR 0020 phần Webhooks (rủi ro trần theo endpoint, RAM M9), 0006, 0016; 0005; README (đổi đích, trần lỗi của ta, bulkhead in-flight, RAM, sweep khi phục hồi, rolling deploy M6, xoay khoá FieldCipher, cảnh báo) | 19 |
| §18.1 spec cha §6 dead-letter, §14 contract; SP3 §23.2 (L7) | 19 |
| §15 span `integrations.fanout`, `integrations.deliver`; metric; log `webhook_ssrf_blocked`, `webhook_body_too_large`, `webhook_secret_unreadable` | 6, 10, 11 |
| Tiêu chí 15 (pipeline xanh) | 20 |

### 2. Race của 6C → cơ chế → test

| Race | Cơ chế | Test |
|---|---|---|
| R6-9 claim đua sweep lấy lại lease | CAS claim trên trạng thái + đến hạn; CAS kết quả fencing `attempts_total` | Task 12 (receiver `hold()` ép worker treo), Task 13 chaos (SIGKILL) |
| R6-10 tắt/xoá endpoint khi đang gửi | claim đọc trạng thái endpoint → `CANCELLED`; lần gửi đang bay hoàn tất | Task 11 |
| R6-11 xoay secret khi đang ký | secret đọc lúc claim; secret cũ còn hạn trong overlap | Task 12 (`hold()` giữa claim và kết quả) |
| R6-12 nhiều lỗi cùng tự tắt | `markFailing` chỉ khi `failing_since IS NULL`; CAS `WHERE status = 'ACTIVE'` | Task 12 (receiver giữ 20 request đã claim, rồi `raceOnRowLock` trên dòng endpoint với 20 lần ghi kết quả xếp hàng; `DB_POOL_MAX = 2 × 20 + 2`, I3) |
| R6-13 retry đua lần thử đang chạy | CAS chỉ từ trạng thái kết thúc → 409 | Task 14 |
| R6-14 recover đua retry | cùng CAS `${TERMINAL}`; recover `FOR UPDATE SKIP LOCKED` | Task 14 (`raceOnRowLock` trên dòng delivery) |
| R6-15 fan-out hai lần | Inbox `(integrations.webhook-fanout, event_id)` cùng transaction | Task 10 |
| R6-25 xoá endpoint đua fan-out | delivery của endpoint đã xoá bị `CANCELLED` lúc claim | Task 11 |
| R6-26 tạo endpoint vượt giới hạn | `OrgMutationLock` (khoá dòng org) + đếm dưới khoá | Task 8 (`raceOnOrgLock`, LIMIT + 2 người xếp hàng) |
| R6-28 lỗi của ta đua lịch/tự tắt | `classifyAttempt` LOCAL: `cycle_base + 1`, `local_failures + 1` cùng CAS, không chạm endpoint; trần → `EXHAUSTED` | Task 11 (×N handler, ×N lease ở sweep) |
| R6C-1 job trùng/tới sớm (sweep, kill switch, stalled) | claim đòi `next_attempt_at <= now + 1 s`; CAS trạng thái; `DEFER` chỉ khi đã đến hạn, `GREATEST` (M1) | Task 11 |
| R6C-2 deadlock đường API ↔ fan-out ↔ claim ↔ ghi kết quả | thứ tự khoá ở Global Constraints: mọi đường giữ dòng endpoint trước delivery, trừ ghi kết quả (delivery `SENDING` → endpoint); claim chỉ cần delivery chưa `SENDING`, API chỉ delivery kết thúc, ghi kết quả chỉ delivery `SENDING` — ba tập rời nhau; sweep `SKIP LOCKED`; `40P01` được `UnitOfWork` retry | Task 11 (in-flight: 10 claim cùng endpoint + ghi kết quả), Task 12, 14 (barrier chạy đồng thời nhiều đường mà không treo) |
| R6C-3 xoá cứng endpoint đua tạo delivery | fan-out `FOR KEY SHARE OF e` (R-X33); sweep `FOR UPDATE SKIP LOCKED` rồi `NOT EXISTS` bằng câu riêng (snapshot mới); endpoint đã xoá mềm không nhận delivery mới | Task 11 sweep.spec (transaction fan-out mở giữ khoá → sweep bỏ qua; sau commit → hoãn, `orphanDeliveries = 0`); Task 10 (khoá thấy bằng `NOWAIT`) |
| R6C-4 hai claim cùng endpoint vượt trần in-flight | khoá dòng endpoint `FOR NO KEY UPDATE` rồi đếm `SENDING` bằng câu riêng (snapshot mới) | Task 11 `deliver-inflight.e2e.spec.ts` (10 claim đồng thời, receiver giữ request: đúng 4 `SENDING`, 6 dời không đếm; endpoint khoẻ của org khác vẫn có slot bulkhead) |

### 3. Quét chỗ trống

Đã tìm `TBD`, `TODO`, "tương tự Task", "thêm xử lý lỗi", "viết test cho": không có. Ô `<…>` chỉ còn ở ba chỗ là **dữ liệu đo** điền lúc thực thi (ADR 0020 W2 Task 1 Step 7; ADR 0013 Task 18 Step 4; ADR 0020 Task 19 Step 1) và `<IMAGE>` lấy từ output của Task 1 Step 4; mỗi chỗ ghi rõ lệnh sinh ra số đó. Dòng W3 của ADR đã viết sẵn bằng kết quả đo thật (R-X33). Hai nhánh có điều kiện được viết đủ code ở cả hai phía: "6A đã merge" (Task 2 Step 6), W2 đạt/không đạt (Task 16 Step 4). Không còn nhánh fallback W3.

### 4. Nhất quán tên và kiểu

- `EndpointRepository` (Task 8: `countLive`, `countLiveUpTo`, `insert`, `setEventTypes`, `insertSecret`, `list`, `find`; Task 9: `update`, `softDelete`, `rotateSecrets`, `signingSecrets`; Task 10: `activeSubscribers` (`FOR KEY SHARE`); Task 11: `lockForClaim`, `forSend`, `clearFailing`, `markFailing`, `autoDisable`, `purgeDue`) — mọi lời gọi ở service/handler dùng đúng tên này.
- `DeliveryRepository` (Task 10: `insertMessage`, `insertDeliveries`; Task 11: `dueEndpointOf`, `claim`, `cancelClaimed`, `messageOf`, `describe`, `finish`, `defer`, `takeOverdue`, `expiredLeases`; Task 14: `view`, `listByEndpoint`, `requeue`, `recover`, `hasRecoverable`). Không còn `deferKilled`, `overdue`.
- `ClaimedDelivery` có `localFailures` (Task 10); `DeliveryResult` `RETRY`/`EXHAUSTED` có `localBump: 0 | 1` — handler (nhánh ENDPOINT `0`), `LocalFailures` (`1`) và sweep (qua `LocalFailures`) đều điền.
- `DeliveryEvent.FAILED.retryLeft` (đổi tên từ `scheduleLeft`), `DEFER`; `DeliveryEffect.localFailures` (Task 4).
- `DeliveryRef.createdAt` luôn là chuỗi ISO micro giây (`CREATED_AT_KEY_SQL`); `ClaimedDelivery.createdAtMs` chỉ cho metric `lag`.
- Job id: `deliveryJobId(publicId, attempt)`, `killedJobId(publicId, attempt, atMs)`, `busyJobId(publicId, attempt, atMs)`, `sweptJobId(publicId, attempt, slot)` (Task 5) — dùng ở Task 10, 11, 13, 14, 17.
- `LocalFailures.record` (Task 11) — dùng ở `DeliverWebhookHandler` (hai nhánh) và `IntegrationsSweepOrgHandler`.
- `WebhookEventCatalogueCheck.known()`/`definitions()` (Task 6) — dùng ở Task 8 (service, controller event types).
- `integrationsCoreImports`, `startIntegrationsApp`, `fixedResolver`, `PUBLIC_IP`, `endpointsUrl` (Task 8); `receiverEnv`, `runDeliver`, `seedPendingDelivery`, `deliveryRow` (+ `local_failures`), `makeDue`, `jobCtx` (Task 11); `raceOnRowLock` (Task 12); `inOrg`, `orgQuery`, `insertEndpoint`, `insertMessage`, `insertDelivery`, `FAKE_SECRET_ENC` (Task 2); `orphanDeliveries` (Task 3).
- Hằng: `WEBHOOKS_OUT`, `WEBHOOK_BREAKER_NEVER`, `CLAIM_CLOCK_SKEW_MS`, `INTEGRATIONS_PURGE_ORDER`, `WEBHOOK_PARTITIONS_LOCK_KEY`, `WEBHOOK_USER_AGENT_SUFFIX`, `WEBHOOK_EVENT_TYPES_MAX`, `INTEGRATIONS_SYSTEM_ACTOR`, `ENDPOINT_AGGREGATE`, `DELIVERY_AGGREGATE` (Task 4); `byteOrder` (Task 8, `domain/webhook-endpoint.ts`).
- `LAST_ERRORS` (13 giá trị, `SECRET_UNAVAILABLE` sau `LEASE_EXPIRED`) = `webhook_deliveries_last_error_ck` cùng thứ tự (`constants-vs-migration.spec.ts`).

### 5. Review Focus → test

| # | Test |
|---|---|
| 1 Host số/rút gọn/dấu chấm cuối | Task 7 `dns-url-guard.spec.ts` "Review Focus 1" |
| 2 Một địa chỉ private giữa địa chỉ công khai, tập rỗng | Task 7 "Review Focus 2" |
| 3 `Retry-After` thiếu/0/lớn | Task 4 `retry-schedule.spec.ts` "Review Focus 3"; Task 11 `deliver.e2e.spec.ts` W-14 + Review Focus 3 |
| 4 Xoay hai lần trong overlap | Task 9 `endpoints-update.e2e.spec.ts` "Review Focus 4" |
| 5 Cursor bị sửa tay | Task 14 `delivery-cursor.spec.ts` (8 dạng) và `deliveries.e2e.spec.ts` (qua HTTP) |

### 6. Phán quyết trên chỗ spec mơ hồ (lý do — giá nếu sai)

1. **R-X27 áp cho `webhook_messages`** (spec r2 còn ghi FK tới `organizations`) — R-X27 mới hơn spec, và `rls-catalog.spec.ts` đã có test "no partitioned table references organizations" sẽ đỏ — sai thì thêm lại FK bằng một migration (nhưng R-X27 cấm).
2. **Không FK `webhook_deliveries → webhook_endpoints` (R-X33)** — spike W3 đo được `AccessExclusiveLock` trên bảng được tham chiếu khi `DETACH` + `DROP` (SELECT bị chặn mỗi tháng); bất biến chuyển sang khoá của người ghi/người xoá + test — sai (một đường ghi mới quên `FOR KEY SHARE`, hoặc một đường xoá mới quên `NOT EXISTS`) thì có delivery mồ côi; `describe` và `VIEW_FROM` (inner join) sẽ ném/ẩn nó, `orphanDeliveries` ở test bắt được nếu đường đó có test.
3. **Kiểm catalog event type theo R-X30** (spec: lệch hai chiều → không khởi động) — rolling deploy và plan sau (6A, SP5) thêm dòng; R-X30 là luật chung cho catalogue — sai thì một dòng DB-only bị bỏ qua thầm lặng (vẫn có WARN + metric).
4. **Không tách hai PR** (phán quyết giữ, M6) — kiểm tolerant ra đời cùng bảng; quyền đã tolerant từ 3A; hệ quả rolling deploy (fan-out bị bỏ qua ở worker cũ, job `integrations.*` retry ở worker cũ) ghi README — sai thì webhook của các event trong cửa sổ rollout bị mất cho org đã kịp tạo endpoint.
5. **`failing_since` không tăng `version`** — ETag là để khách sửa endpoint; sức khoẻ đổi liên tục sẽ làm mọi `PATCH` của khách `412` — sai thì khách thấy `failingSince` cũ hơn ETag (chấp nhận được: trường chỉ đọc).
6. **`attempts` của API = `attempts_total` (gồm lần claim bị huỷ)** — cột duy nhất tăng đơn điệu, cũng là fencing token; README ghi nghĩa — sai thì thêm cột đếm lần gửi thật (migration cộng thêm). Từ chối claim vì bận không tăng cột này.
7. **Claim đòi đến hạn ± 1 s** — chặn job trùng của sweep/kill switch/stalled tiêu lịch sớm; spec không nói — sai thì lệch đồng hồ > 1 s giữa Redis và DB làm job hẹn lại tới hơi sớm bị bỏ, sweep đưa lại sau grace (trễ tối đa `INTEGRATIONS_SWEEP_GRACE_SEC` + một chu kỳ cron).
8. **Mục `webhooks` của OpenAPI không phụ thuộc module integrations** — spec: "cho mọi event `webhook: true`"; cờ là hợp đồng của module phát event — sai thì tài liệu liệt kê payload mà dự án tắt integrations không gửi (chỉ là tài liệu).
9. **`GET /v1/webhook-event-types` không phân trang** — catalog vài chục mục, mẫu `/v1/permissions` — sai thì thêm `page` (thay đổi cộng thêm).
10. **Sweep enqueue lại mỗi cửa sổ grace** (`slot = floor(now / grace)`) và "chạm" `next_attempt_at` dòng đã lấy (M5) — spec chỉ nói "enqueue lại"; jobId cố định sẽ bị BullMQ nuốt khi job cũ còn giữ; không chạm thì backlog lớn hơn trần lấy lại mãi cùng các dòng cũ nhất — sai thì vài job trùng (vô hại, claim là CAS).
11. **Recover/retry/test cho endpoint đã xoá mềm → 404** (spec chỉ nói `409` khi không `ACTIVE`) — endpoint đã xoá không còn trên API — sai thì đổi thành `409` (một dòng).
12. **`rotate-secret` cũng `@RequireVerifiedEmail()`** (spec: "session mới") — trả secret như lúc tạo, cùng mức bảo vệ — sai thì bỏ một decorator.
13. **R-X34 bằng route riêng, không kiểm trong service** — guard là metadata route của `AuthGuard` toàn cục; identity không có API theo request cho "session mới" — sai (nếu muốn một route) thì cần thêm API vào identity, ngoài 6C.
14. **`local_failures` cộng dồn trong chu kỳ, không "liên tiếp"** (R-X35 nói "đếm lỗi của ta") — lỗi của endpoint xen giữa không đặt lại bộ đếm; đặt lại chỉ khi `retry`/`recover` — sai (muốn "liên tiếp") thì đặt lại ở nhánh ENDPOINT/SUCCEEDED (một cột trong CAS).
15. **Bận (đủ in-flight) không phải lỗi** (R-X35) — không tăng `attempts_total`, không `local_failures`; endpoint chết mãi chỉ dừng khi endpoint tự tắt — sai thì delivery chờ của endpoint chết xoay vòng 30 s một lần tới khi tự tắt (đã ghi README).
16. **Lease hết hạn không tính vào in-flight** — worker đã chết, sweep sẽ hẹn lại; tính vào sẽ khoá endpoint tới lượt sweep — sai thì sau một worker chết, endpoint có thể nhận thêm tối đa N request trước khi sweep dọn lease cũ (vẫn có trần).

### 7. Hạng mục 6C không đặt ở plan này (và nơi xử lý)

- **Dòng `webhook_event_types` của `files.file.ready`/`files.file.deleted`:** chỉ ở plan này nếu 6A merge trước (Task 2 Step 6); ngược lại 6A mang (spec §17 Bảng 4).
- **Helm egress cho webhook, nhóm worker riêng của `webhooks-out`** (spec §18.4 amendment D2): 7B; plan này chỉ ghi README.
- **D-4 (admin đọc `WebhookStatsReader` với `disable: ['integrations']`)**: 6D; plan này cài token và test bản cài (Task 10), X-9 chứng minh tắt module (Task 13).
- **A-1 (event `integrations.*` vào audit)**: 6B tự phủ qua bộ chọn `AUDITED_EVENTS`; plan này khai `audit: true`.
- **Runbook xoay khoá `FieldCipher` tự động**: SP7 (ADR 0010/0016); plan này ghi điều kiện ở README.
- **Trần in-flight theo org, trần response riêng cho `webhooks-out` (M9):** việc sau, ghi ADR 0020 + README; R-X35 chỉ đòi trần theo endpoint.
- **M10, M11 (review 6C):** chấp nhận như coordinator ghi; không có thay đổi plan riêng ngoài các mục trên.

### 8. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **(Yếu nhất) Đếm in-flight bằng câu riêng sau khi khoá endpoint thấy claim vừa commit (READ COMMITTED, snapshot mỗi câu)** — đúng với isolation mặc định của `UnitOfWork` (không truyền `isolation`, `mikro-orm-unit-of-work.ts`); nếu một caller chạy claim dưới `REPEATABLE READ` thì hai claim cùng thấy N−1. Kiểm: `deliver-inflight.e2e.spec.ts` (đúng 4 `SENDING` với 10 claim đồng thời) và RED bằng gộp đếm vào câu khoá.
2. `FOR KEY SHARE OF e` trong câu có `JOIN` + `ORDER BY` của `activeSubscribers` chỉ khoá dòng endpoint (không khoá `webhook_endpoint_event_types`). Kiểm: Task 10 ca R-X33 (`FOR UPDATE NOWAIT` → `55P03`, `FOR NO KEY UPDATE NOWAIT` → tự do).
3. `oasdiff` v0.1.17 so mục `webhooks` (spike W2); không → nhánh (b) của Task 16.
4. Driver knex trải mảng JS cho `ARRAY[?]::text[]`/`unnest(ARRAY[?]::uuid[], ARRAY[?]::bigint[])`/`ANY(ARRAY[?]::bigint[])` qua `Db.execute`. Kiểm: Task 8 (`setEventTypes`), Task 10 (`insertDeliveries`), Task 11 (`purgeDue`) — đỏ thì đổi sang một `?` mỗi phần tử sinh từ độ dài mảng.
5. `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` trên bảng partitioned (`takeOverdue`). Kiểm: Task 11 ca M5.
6. Docker cho user 65532 nghe 443 trong container smoke (`sysctls` đã ghi tường minh); không → receiver nghe 8443 và smoke thêm `RESILIENCE_ALLOWED_PORTS=443,8443` chỉ trong env smoke.
7. `make_interval(secs => ?::double precision / 1000)` qua placeholder của knex nhận số JS (Task 11). Đỏ → truyền giây đã chia ở app.
8. Request API key của user tới route tenant có `x-api-key` + `origin` (mẫu `platform-staff-action.conformance.ts`) — Task 9 ca R-X34 chỉ khẳng định `/destination` từ chối (`403 forbidden`), không dựa vào việc route thường nhận API key.

### 9. Phụ thuộc thật với plan khác và xung đột file dự kiến

- **Phụ thuộc cứng:** 6.0, 7A, 3A–3D, 4B (đã trên `main` tại `bd6da1b`). Không phụ thuộc 6A, 6B, 6D, 4C, 7B.
- **Xung đột với 6A (cùng W3):** `package.json`/`pnpm-lock.yaml`/`renovate.json` (hai package khác nhau: giữ cả hai, `pnpm install` lại); `.dependency-cruiser.cjs` + `rules.spec.ts` (luật 20 vs 21: giữ cả hai; ngoại lệ `no-orphans` của `admin-readers.ts`: plan nào merge sau thấy đã xoá thì bỏ qua); `src/boilerplate.module-keys.ts`, `src/boilerplate.modules.ts`, `test/unit/composition/compose.spec.ts` (thêm `files` rồi `integrations` theo thứ tự merge); `test/support/core-catalog.ts` (hằng `_6A` và `_6C` cùng nối vào union); `test/support/tenancy-seed.ts` (`PURGE_ORDER`: 100 → 110 → 120 → 1000); `rls-catalog.spec.ts` (`GLOBAL_TABLES`: `file_purposes` và `webhook_event_types`; ca R-X33 mới cũng áp cho bảng partitioned của 6A nếu có); `normalization-inventory.spec.ts`; `src/core/logging/redaction.ts` (khoá S3 và khoá webhook, cùng khối); `test/smoke/compose.smoke.yaml`, `gen-certs.sh` (SAN `DNS:minio` và `DNS:webhook-receiver` cùng dòng), `smoke-app-env.ts`; `docs/adr/0020-files-audit-webhooks.md` (hai mục khác nhau), `docs/adr/0013-build-toolchain.md` (hai dòng số đo: plan sau đo lại so với dòng của plan trước), `docs/adr/0016` (ngoại lệ SDK S3 vs `webhooks-out`), `docs/boilerplate/README.md` (hai mục khác nhau); `openapi.json`, `.env.example` (sinh lại sau merge, không giải tay); Bảng 4 của spec (migration `…_webhook_file_events` chỉ do plan merge sau mang).
- **Xung đột với 7B (cùng W3):** `.env.example` (sinh lại); nếu 7B có bước sinh danh sách env/secret cho chart từ registry config thì chạy lại generator của 7B sau khi merge (6C không có env bí mật nên `pnpm chart:secrets --check` không đổi); `docs/boilerplate/README.md` (mục Helm của 7B có thể cần dòng egress webhook — README của 6C đã ghi, 7B chép vào chart docs).
- **Xung đột với 4C:** `test/support/tenancy-seed.ts` (4C sửa `ENTITLEMENTS_PURGE_STATEMENTS` ở file khác, không đụng `PURGE_ORDER` của 6C trừ khi 4C thêm participant mới); `rls-catalog.spec.ts`/`normalization-inventory.spec.ts` (dòng khác nhau); `openapi.json` (sinh lại); không xung đột code.
