# Sub-project 7 — Feature mẫu, Helm chart, runbook, quy trình upstream

- **Ngày:** 2026-09-28.
- **Trạng thái:** Bản thiết kế **r2, đã chốt 2026-09-29** (controller chốt theo uỷ quyền "tự chốt, tự làm hết"; các giả định chưa chạy được kiểm bằng spike ở đầu plan tương ứng). r1 sửa theo review vòng 1 (ba slice: interfaces, money-security, ops) và phán quyết chéo R-X1…R-X11 (nhật ký ở mục 25); r2 sửa theo review hội tụ vòng 2 `sp4-7-review-r2.md` và phán quyết R-X12…R-X19 (`.superpowers/autonomous/rulings.md`; nhật ký ở mục 26). Registry order purge trích từ addendum SP3 của plan 3D `2026-09-28-sp3-addendum-platform-staff.md` ("addendum 3D §An"). Sếp đã giao toàn quyền quyết kỹ thuật ("tự chốt, tự làm hết"). Mọi quyết định em tự chốt nằm ở mục 4, kèm lý do và phương án đã loại. Mục "Cần Sếp quyết" (mục 23) hiện không có việc nào.
- **Spec cha:** `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, gồm Phụ lục C mục 7, §13 (Deployment, build, Docker) và §1.1 (vùng sở hữu, nhận cập nhật upstream). Chỗ nào lệch spec cha hoặc spec SP trước thì ghi ở mục 21.
- **Nền tảng bắt buộc:**
  - SP1: `src/core/*`, gồm `UnitOfWork`, `OrgScope`, `Db`, outbox/inbox, `SafeEnqueue`, `defineJob`/`defineCron`, `Paginator`, `@Idempotent()`, `FieldCipher`, health, OTel.
  - SP2: `src/modules/identity`, `src/modules/notifications`, Bull Board read-only.
  - SP3 **r8** đã commit (`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, per R-X11). Spec này dùng **đúng** các interface sau của SP3:
    - `OrgScope` và GUC `app.org_id` với `app_current_org()`;
    - policy `<bảng>_tenant TO app_user` (§6.1); quy ước hàm definer `SECURITY DEFINER SET search_path = ''`, tham số ngoài biên → `RAISE`, `REVOKE … FROM PUBLIC; GRANT EXECUTE … TO app_user` (§6.14);
    - `definePermissionCatalogue` với `@PermissionCatalogueContributor`, và `@OrgPurgeParticipantContributor({ key, order })` (marker của `DiscoveryService`, §9.5);
    - `JobDef.onInactiveOrg` và `OrgActivityGate`;
    - event `tenancy.org.deleted` và `tenancy.org.purged`;
    - FK `org_id → organizations RESTRICT` (amendment B5);
    - lệnh reset 2FA nhân viên `dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js` (§5.2, 3D);
    - migration chia theo plan (§6.13).
  - SP4 r2 (Entitlements, `.superpowers/sp4/sp4-entitlements-design.md`): mẫu dùng **đúng** API công khai SP4 §6.4: `defineFeatureCatalogue` + `@FeatureCatalogueContributor`, `<Catalogue>.requireEnabled(key)` (gắn `EntitlementInterceptor` route-scoped, S4-D7), `Quotas.consumeOrThrow`, `Quotas.releaseAllocation`, bảng `entitlement_features` (mục 10.4).
  - SP6 r2 plan 6.0 (core): role `sweep_definer` và helper `defineOrgSweep` dùng chung (per R-X4), với hợp đồng chốt theo R-X14: tên hàm SQL chữ ký cố định `(p_after uuid, p_limit integer, …)` cộng tham số thêm theo tên (`extraParams`), SP6 §5.3; cờ `audit`/`webhook` bắt buộc của `defineEvent` (per R-X3).
- **Nguồn version** (kiểm ngày 2026-09-28 trên GitHub Releases và npm registry, không dùng blog):

  | Công cụ | Version |
  |---|---|
  | Helm | 4.3.0 (2026-09-09) và 3.22.0 (2026-09-10) |
  | kubeconform | v0.8.0 (2026-06-04) |
  | `azure/setup-helm` | v5.0.1 (2026-06-23) |
  | kind | v0.33.0 (2026-08-26) |
  | `helm/kind-action` | v1.15.0 (2026-09-02) |
  | image `kindest/node` | v1.37.0 và v1.34.11 |
  | Kubernetes, bản vá mới nhất mỗi nhánh (2026-09-23) | 1.37.1, 1.36.5, 1.35.9, 1.34.12 |
  | `yannh/kubernetes-json-schema` | có `v1.37.1-standalone-strict` (HTTP 200) |
  | `datreeio/CRDs-catalog` | có `policies.kyverno.io/imagevalidatingpolicy_v1`, `gateway.networking.k8s.io/httproute_v1` |
  | `googleapis/release-please-action` | v5.0.0 (2026-04-22) |
  | Kyverno | 1.19.1 (2026-09-10) |
  | sigstore policy-controller | v0.15.1 (2026-03-26; đã loại) |
  | cosign | v3.1.3 |
  | npm `yaml` | 2.9.1 (latest, đã có sẵn trong lockfile) |
  | helm-unittest | v1.1.2 (đã loại) |
  | image `axllent/mailpit` (kind, SMTP AUTH) | v1.31.3 (2026-09-27); `MP_SMTP_AUTH`, `MP_SMTP_AUTH_ALLOW_INSECURE` đọc từ `cmd/root.go` của tag |
  | image `ghcr.io/navikt/mock-oauth2-server` (kind, IdP OIDC giả) | 6.0.3 (2026-09-25) |

- **Bằng chứng đọc từ code** (worktree `sp2-identity`, f6ed8d2; r1 đọc lại mọi dòng dưới):
  - `Dockerfile`: ENTRYPOINT distroless là `/nodejs/bin/node`, `USER 65532`.
  - `compose.yaml`: cách chia secret theo vai trò và các probe.
  - `core/health/health.config.ts`: `HEALTH_CHECK_TIMEOUT_MS` 500 ms, drain 5 s.
  - `core/config/app.config.ts`: `APP_ROLE` là enum `api|worker|migrate`, không có default.
  - `core/queue/worker-host.ts:137-155`: `WORKER_QUEUES`, tên lạ → ném lỗi.
  - Queue hiện có (`defineQueue`): `maintenance`, `events`, `notifications`.
  - `core/outbox/outbox.relay.ts:106`: relay tự chạy khi `OUTBOX_AUTOSTART`.
  - `core/scheduler/static-scheduler.ts`: đồng bộ cron tĩnh ở **mọi** worker, idempotent.
  - `core/observability/metrics.ts`: `queue_depth`, `queue_oldest_job_age_seconds`, `outbox_lag_seconds`, `outbox_parked_events`; xuất qua OTLP, **không** có endpoint `/metrics`.
  - `telemetry-lifecycle.ts`: `NodeSDK` với `serviceName`.
  - `main.migrate.ts`: import `all-configs.js`, nên validate cả `REDIS_URL` và `FIELD_ENCRYPTION_KEYS`.
  - `migrator.ts`: `transactional` + `allOrNothing`, không có khoá chống chạy song song; `MikroORM.init` mở **pool** pg, nên khoá phiên lấy qua `orm.em` nằm trên một connection mượn rồi trả về pool (lý do của S7-D24 r1).
  - Đăng ký toàn cục lúc import (lý do của S7-D7 r1):
    - `defineConfig` gọi `registerConfigEntry` (`define-config.ts:47`); `validateAllConfigs()` validate **mọi** namespace đã đăng ký (`validate-all.ts`);
    - `defineQueue`/`defineJob` (`job-definition.ts`) và `defineCron` (`cron-definition.ts`) là lệnh cấp module trong `jobs.ts`;
    - `WorkerHost.resolveQueues()` consume mọi queue trong `queueRegistry()` khi `WORKER_QUEUES` rỗng, rồi `assertHandlersFor` ném khi job trên queue được consume thiếu `@JobHandler` (`worker-host.ts`);
    - `StaticScheduler.sync()` upsert mọi cron đã đăng ký và **chỉ** xoá cron đã `retireCron` (`static-scheduler.ts`);
    - `main.api.ts`/`main.worker.ts` import tĩnh `AppApiModule`/`AppWorkerModule` → `app.modules.ts` → mọi module, rồi mới gọi `validateAllConfigs()`;
    - `composition.config.ts` import tĩnh index của identity và notifications;
    - mọi khoá cron hiện có mang tiền tố tên module hoặc `core.` (`identity.*`, `notifications.*`, `core.outbox.cleanup`, `core.scheduler.reconcile`).
  - Luật config không biết vai trò (lý do của C2 r1, mục 6.5):
    - `smtp-auth-pair` (`notifications.config.ts`) đòi `SMTP_USER`/`SMTP_PASSWORD` cùng có ở mọi vai trò, trong khi `smtp-required-on-worker` bên cạnh đã xét `c.app?.role`;
    - `identity.config.ts` (`superRefine` của schema) đòi cặp Google và bộ bốn OIDC `hybrid` ở mọi vai trò; worker cũng dựng Better Auth (`BetterAuthCoreModule` trong `forWorker`) và `assertAuthProvidersRegistered` chạy ở cả hai vai trò;
    - `database.config.ts`: `appPassword: z.string().min(1)` bắt buộc ở mọi vai trò; luật production `database-query-deadline` trả lỗi khi thiếu namespace `http`;
    - tiền lệ đúng đã có: `relayPassword`/`ownerPassword` là `optional()` và được kiểm ở chỗ dùng (`database.module.ts`, `migrator.ts`); luật `authDatabase` xét `c.app?.role !== 'migrate'`.
  - Metadata secret: không có metadata máy đọc được; "(secret)" chỉ nằm trong chuỗi `.describe()` và không nhất quán (`DB_APP_PASSWORD` không có). Zod 4.6.5 `.meta({ … })` gộp với `.describe()` trong `z.globalRegistry` (đã chạy thử).
  - `RESILIENCE_ALLOWED_PORTS` mặc định `80,443` (`resilience.config.ts`); `OTEL_ENABLED` mặc định `false` (`otel.config.ts`).
  - Cờ `--wait`, `--timeout`, `--rollback-on-failure` của Helm 4.3.0 theo review ops (đọc `pkg/cmd` ở tag): `--wait` không giá trị = `watcher`; `--timeout` áp cho **từng** thao tác (gồm Job hook); `--atomic`/`--force` đã deprecated.
  - MikroORM 7.2.1 `AbstractMigrator.js:56-63,457-458`: `getPending` = mọi migration chưa chạy, **không** đòi đúng thứ tự tên. Vì vậy migration upstream có timestamp cũ hơn migration của dự án vẫn chạy được.
  - `auth.cli-config.ts`: gọi `appConfig()`, nên lệnh CLI cần `APP_ROLE` trong env.
  - Better Auth 1.7.6:
    - `context/create-context.mjs:70-80` và `secret-utils.mjs`: `options.secrets` có version. Khi có, `secret` = `secrets[0]`, còn `secretConfig` giữ mọi version cộng `legacySecret`.
    - Cookie phiên ký bằng `ctx.context.secret` (chỉ bản hiện tại: `api/routes/session.mjs:40`, `cookies/index.mjs:172`). Bearer cũng vậy (`plugins/bearer/index.mjs:37-40`).
    - Mã hoá 2FA, backup code và private key JWKS dùng `secretConfig` (`plugins/two-factor/*`, `plugins/jwt/utils.mjs:49-55`).
    - `better-auth/crypto` export `symmetricEncrypt`, `symmetricDecrypt`, `parseEnvelope`.
  - BullMQ 6.3.8 (`node_modules/bullmq/dist/esm/classes/*.d.ts`):
    - `Queue.retryJobs(opts?: { count?, state?, timestamp? }): Promise<void>` retry **mọi** job ở trạng thái đó (`count` chỉ là cỡ lô mỗi vòng Lua), không lọc theo tên, không trả số lượng;
    - `Queue.getJobs(types?, start?, end?, asc?): Promise<Job[]>`, `getJobCounts(...types)`, `pause()`, `resume()`, `isPaused()`;
    - `Job.retry(state?: 'completed' | 'failed', opts?): Promise<void>` ném khi job không tồn tại, đang bị khoá hoặc không ở trạng thái mong đợi.
  - `pg` 8.23.0 là dependency trực tiếp (`Client` với `keepAlive`).
  - Role `app_owner` không có `idle_session_timeout` (`docker/postgres/init/01-roles.sh` chỉ đặt `idle_in_transaction_session_timeout` cho `app_user`, `app_relay`, `auth_user`).

**Ký hiệu:**
- **S7-D1…S7-D36**: quyết định em tự chốt (mục 4).
- **T7-1…T7-5**: spike (mục 5).
- **R7-1…R7-18**: race có tên (mục 16).
- Mã test:
  - `EX-*`: feature mẫu;
  - `HC-*`: Helm chart;
  - `UP-*`: quy trình upstream;
  - `KR-*`: xoay khoá;
  - `QA-*`: CLI quản trị queue;
  - `RB-*`: runbook;
  - `CO-*`: thay đổi core.

---

## 1. Mục tiêu và tiêu chí hoàn thành

Sau sub-project này, một dự án clone từ boilerplate có:
- một feature mẫu chạy thật, dùng làm khuôn để chép;
- một Helm chart deploy được lên Kubernetes với cấu hình bảo mật của spec cha §13.3;
- runbook cho các sự cố thường gặp;
- một quy trình nhận bản vá upstream có công cụ và CI chặn sửa nhầm vùng boilerplate.

Mọi tiêu chí phải được chứng minh bằng test chạy trên hạ tầng thật: Testcontainers, image thật với compose `--profile app`, và cụm kind có Pod Security Admission `restricted`.

1. **Feature mẫu đi hết đường của boilerplate.** `src/features/example` là tài nguyên `Project` theo org, chạy trọn qua HTTP trên image thật. Nó có:
   - RLS fail-closed;
   - quyền CASL đăng ký qua catalogue riêng;
   - cổng tính năng (`FLAG` `example.projects`) và quota (`QUOTA` kỳ `NONE` `example.project_count`) của SP4;
   - tạo có `Idempotency-Key`;
   - event outbox cùng transaction, có cờ `audit`/`webhook` tường minh (per R-X3);
   - một cron quét chéo org bằng helper dùng chung của core (per R-X4), tỏa ra thành job theo org chạy trong `OrgScope`;
   - participant xoá cứng org (`order` 200, per R-X5);
   - migration có down đã test.

   Test RLS (EX-I1…EX-I5) và test catalog của SP3 xanh với bảng mới. Tạo song song `limit + k` project trong một org cho **đúng** `limit` project và `k` lỗi `422 quota_exceeded`. Bộ đếm quota luôn bằng số dòng (EX-E7).
2. **Feature mẫu chép được.** Tài liệu "tạo feature từ mẫu" (mục 6.3.3) liệt kê đủ mọi định danh phải đổi. Test EX-U9 chứng minh không định danh nào của mẫu bị viết cứng ngoài danh sách đó: quét `src/features/example` và `src/migrations/example`, mọi chuỗi `example`/`Example`/`EXAMPLE` đều thuộc tập định danh đã liệt kê.
3. **Helm chart đạt bảo mật lúc chạy của §13.3 và qua kiểm tra tĩnh.**
   - `helm lint --strict` với mọi file values mẫu xanh trên Helm 4.3.0 và 3.22.0.
   - `helm template | kubeconform -strict` xanh trên schema Kubernetes 1.34.12 và 1.37.1, và schema CRD của catalog.
   - Test render (HC-1…HC-30) xanh.
   - Chart được cài lên kind vào namespace gắn `pod-security.kubernetes.io/enforce=restricted`. Mọi pod chạy (PSA không từ chối pod nào), job migrate chạy trước khi pod mới lên, `/health/ready` trả 200, và `helm rollback` về revision trước thành công (HC-K1…HC-K9). Kind smoke chỉ dùng route của vùng boilerplate, nên vẫn xanh trên cây đã xoá vùng template (UP-13).
4. **Chart không bao giờ chứa secret, và mỗi vai trò khởi động được với đúng phần secret của nó.**
   - Không template nào sinh `kind: Secret`.
   - Danh sách tên env secret và vai trò được phép **sinh từ code** (metadata `secret` trên schema config, S7-D33), không phải regex hay bảng viết tay. `values.schema.json` từ chối đúng các tên đó trong `config`/`api.env`/`workers.*.env` (HC-5, HC-6, HC-30).
   - Mỗi vai trò chỉ nhận đúng các khoá secret mà code khai cho vai trò đó (HC-7). Ví dụ: api không có `DB_OWNER_PASSWORD` hay `SMTP_PASSWORD`, worker không có `AUTH_GOOGLE_CLIENT_SECRET`, migrate chỉ có `DB_OWNER_PASSWORD`.
   - Luật config nào đòi một secret thì chỉ đòi ở vai trò được nhận secret đó (mục 6.5, C2). CO-4 khởi động validate của mọi vai trò với **chỉ** phần secret của nó trên ma trận config (SMTP AUTH, Google, `local`/`hybrid`/`external`, `NODE_ENV=production`, module SP5/SP6 khi đã có); HC-K9 chạy cùng điều đó trên kind với SMTP AUTH thật, Google và `hybrid` qua IdP giả.
5. **Migration chạy đúng một lần, trước rollout, và fail to.**
   - Job hook `pre-install,pre-upgrade` có `backoffLimit: 0` và khoá advisory trên một `pg.Client` riêng giữ suốt lượt chạy: hai migrator song song thì một bên thoát ngay với lỗi rõ, kể cả khi lượt đầu chạy lâu hơn idle timeout của pool (CO-2, CO-2b).
   - Migration lỗi thì release fail, pod cũ giữ nguyên, và log của Job in ra ngay trong output của `helm upgrade` (HC-K4).
6. **Quy trình upstream có công cụ và CI.**
   - Script `pnpm upstream:sync vX.Y.Z` merge một tag upstream, tự giải các loại xung đột đã biết (template, file sinh, vùng boilerplate) và dừng ở xung đột thật.
   - Workflow `upstream-guard` của dự án fail khi vùng boilerplate ở `HEAD` khác cây của commit upstream đã ghi trong `.upstream/version.json` (UP-1…UP-13). Bộ kiểm chạy từ bản `check.mjs` **của commit upstream**, không phải bản ở `HEAD`.
   - Squash-merge PR đồng bộ upstream làm guard fail ở lần chạy sau (UP-6), và có quy trình khôi phục đã test (UP-6b).
   - CI upstream fail khi có file chưa được phân vùng, hoặc khi upstream track một file vùng dự án ngoài tập hạt giống (UP-9).
   - **Tắt module thật sự tắt nó** (S7-D7): `disable: ['<m>']` làm config, luật config, queue, job và cron của module đó không được đăng ký; env của nó không bắt buộc và không có trong `.env.example`; cron tĩnh đã đồng bộ từ trước bị gỡ (UP-12b, UP-12c).
7. **Upstream phát hành có kiểm soát.** Tag `vX.Y.Z` và `CHANGELOG.md` do release-please sinh. `Chart.yaml` cùng version. Mọi release có mục "Upgrade notes" khi có migration, env mới hoặc đổi export công khai (mục 13.6).
8. **Runbook đủ bảy tình huống:** deploy, rollback, migration lỗi, queue tồn đọng, DB failover/PgBouncer, reset 2FA nhân viên, xoay khoá.
   - Mỗi runbook có đủ các mục: tín hiệu, tác động, chẩn đoán, hành động, kiểm lại, leo thang.
   - Lệnh trong runbook deploy, rollback và migration lỗi được chính job kind smoke chạy (HC-K2…HC-K5), với cờ Helm 4.3 đã chốt (mục 14.1; runbook đòi Helm ≥ 4.3).
   - Test RB-1 chứng minh mọi tên env, metric và script được nhắc trong runbook đều có thật.
9. **Xoay khoá không mất dữ liệu.**
   - Với `FieldCipher`: thêm kid → đổi kid active → cron mã hoá lại mọi dòng thuộc tập "REWRITE" → gauge về 0 → bỏ kid cũ, và không dòng nào hỏng (KR-1…KR-8).
   - Với secret của Better Auth (sau spike T7-1): thêm version → đổi version hiện tại → 2FA và JWKS vẫn chạy (người dùng chỉ phải đăng nhập lại) → cron mã hoá lại → bỏ version cũ (KR-9…KR-13).
10. **Không thay đổi hành vi SP1–SP6 ngoài các dòng liệt kê ở mục 6.5 và các amendment mục 21.** Pipeline đầy đủ của mỗi plan xanh: lint, type-check, unit, integration, migration up → down → up cộng sweep S2-R57, `oasdiff`, luật kiến trúc, prod-like.

---

## 2. Phạm vi

**Trong phạm vi:**
- `src/features/example/`, `src/migrations/example/`, `test/{unit,integration,e2e}/features/example/`.
- `deploy/helm/saas-app/` (chart), `deploy/values/example.yaml`, `deploy/policy/kyverno-verify-image.yaml`, `deploy/tools.env`.
- `test/deploy/` gồm test render và manifest hạ tầng cho kind (chỉ để test).
- `.upstream/`, `tools/upstream/`, workflow `upstream-guard.yml`, `release-please.yml` và job `chart`, `kind-smoke` trong CI.
- `CHANGELOG.md`, `release-please-config.json`, `.release-please-manifest.json`.
- Chuyển nội dung README gốc sang `docs/boilerplate/`.
- `docs/runbooks/*.md` và `docs/upstream/*.md`.
- Thay đổi nhỏ ở core, identity và notifications liệt kê ở mục 6.5:
  - `WORKER_QUEUES_EXCLUDE`;
  - migrate chỉ validate namespace cần;
  - luật config theo vai trò (SMTP AUTH, Google/OIDC, `DB_APP_PASSWORD`, luật production cần `http`);
  - metadata `secret` trên schema config + script sinh danh sách secret cho chart;
  - khoá advisory của migrator trên `pg.Client` riêng;
  - CLI quản trị queue;
  - registry "tập trường mã hoá" cùng cron mã hoá lại;
  - `AUTH_SECRETS` có version (sau spike);
  - `src/boilerplate.modules.ts` cùng `composeAppModules` nạp module lười, luật config chéo module theo tập module đang bật;
  - `gen-env-example` đọc từ composition;
  - điểm mở rộng inventory cho test, luật dependency-cruiser và kiểu của dự án.
- ADR 0021 (deploy Kubernetes bằng Helm; số theo R-X6). Cập nhật ADR 0002, 0006, 0010, 0013.

**Ngoài phạm vi** (điểm mở rộng ở mục 22):
- Chart cho Postgres, PgBouncer, Redis hay OTel collector: đó là hạ tầng của dự án. Chart chỉ nối tới chúng.
- `ServiceMonitor`/`PrometheusRule` (S7-D13).
- KEDA.
- Argo Rollouts.
- Publish chart lên OCI registry (S7-D11).
- Generator feature tự động (S7-D29).
- Audit, phê duyệt hai người (SP6).
- Xoá theo lô qua nhiều transaction.
- Service mesh.
- Backup/PITR tự động: đây là tính năng của Postgres managed; runbook chỉ nêu điểm kiểm.

---

## 3. Ràng buộc toàn cục (bắt buộc cho plan và code)

Giữ nguyên mục 3 của spec SP1, SP2 và SP3. Riêng SP7:

1. **Package và tool trước, tự viết sau.**
   - Chỉ thêm devDependency `yaml` (đã có 2.9.1 trong lockfile qua transitive; `pnpm add -D yaml` không ghi version, mong đợi 2.9.1).
   - Tool CI được pin theo version **và** SHA-256 trong `deploy/tools.env` (Renovate regex manager, như `docker/images.env`). Gồm: Helm 4.3.0, kubeconform v0.8.0, kind v0.33.0, image `kindest/node` pin digest.
   - Image chỉ dùng trong test kind thêm vào `docker/images.env` theo digest: `ghcr.io/navikt/mock-oauth2-server:6.0.3` (mới); Mailpit đã có (Renovate nâng lên v1.31.3).
   - Action GitHub pin theo commit SHA, như CI hiện có: `azure/setup-helm` v5.0.1, `helm/kind-action` v1.15.0, `googleapis/release-please-action` v5.0.0.
   - Lệnh cài ra version khác mong đợi thì dừng, đọc changelog, cập nhật spec.
2. **Không đoán API.**
   - Cờ CLI của Helm 4.3.0 đã được review ops đọc từ `pkg/cmd` ở tag (O-2 đóng ở r1): runbook dùng `--wait` (không giá trị = `watcher`) và `--timeout`; không dùng `--atomic`/`--force` (deprecated). Kind smoke chạy đúng các lệnh này, nên cờ sai thì CI đỏ.
   - API Kyverno `ImageValidatingPolicy` đọc từ schema CRD của catalog và tài liệu 1.19.
   - `symmetricEncrypt`/`parseEnvelope` của Better Auth đọc từ `.d.mts` của 1.7.6.
3. **Không hard-code.**
   - Mọi ngưỡng, lịch, retention của feature mẫu nằm trong config.
   - Mọi giá trị deploy (host, port, CIDR, replica, tài nguyên) nằm trong values.
  - Chart không chép lại mặc định của app. Giá trị app mà chart cần để tính (`DB_MIGRATION_STATEMENT_TIMEOUT_MS`, `RESILIENCE_ALLOWED_PORTS`) phải được đặt tường minh trong values; thiếu thì `helm template` fail.
   - Chart không nhúng tên namespace, domain hay IP nào. Ngoại lệ: dải địa chỉ riêng chuẩn (RFC 1918, link-local, CGNAT, ULA) là hằng có tên trong `_helpers.tpl`.
4. **Bất biến ở DB** cho feature mẫu: `CHECK`, `UNIQUE`, FK `RESTRICT`, RLS FORCE. Bất biến của chart nằm ở `values.schema.json` cộng `fail` trong template. Bất biến của vùng sở hữu nằm ở `zones.json` cộng CI.
5. **Fail loud.** Ví dụ:
   - values thiếu hoặc mâu thuẫn → `helm template` fail;
   - vùng boilerplate bị sửa → CI fail;
   - dòng không giải mã được → metric cộng log ERROR, không bao giờ bỏ qua im lặng;
   - hai migrator song song → exit 1.
6. **Feature mẫu theo đúng luật của boilerplate** như một dự án thật. Không có ngoại lệ nào của "mẫu" mà dự án chép sang lại thành lỗ hổng.

---

## 4. Quyết định (em tự chốt)

| # | Quyết định | Lý do | Phương án đã loại |
|---|---|---|---|
| S7-D1 | Resource mẫu là `Project`, có trạng thái `ACTIVE`/`ARCHIVED`. Project đã lưu trữ quá `EXAMPLE_ARCHIVED_RETENTION_SEC` bị cron xoá cứng | Một resource nhỏ mà đủ mọi đường: CRUD, state machine, quota, cron chéo org, job theo org, participant | (a) Ghi chú CRUD không có trạng thái: không minh hoạ được state machine và cron. (b) Mỗi project một delayed job "xoá sau N ngày": mất Redis là mất lịch, trái §9 "trạng thái trong DB + cron đối soát" |
| S7-D2 | Cron chéo org tỏa ra bằng **hàm `SECURITY DEFINER` chỉ đọc** do `sweep_definer` sở hữu (role chung cho mọi quét org đến hạn, per R-X4), gọi qua **helper quét dùng chung của core** (SP6 6.0, per R-X4): cron của helper chạy ở queue `maintenance`, đi các lô keyset, enqueue mỗi org một job theo lược đồ `jobId` duy nhất của helper; job theo org chạy trong `OrgScope` ở queue của feature | Một cơ chế cho SP4–SP7 (R-X4): mẫu dạy đúng thứ dự án sẽ chép; chỉ lộ `org_id`; không cần role BYPASSRLS | (a) Tỏa ra cho **mọi** org đang hoạt động qua một port của tenancy: O(số org) job mỗi ngày cho mỗi feature, gần như toàn no-op. (b) `app_admin` BYPASSRLS: SP3 không tạo role này. (c) Dùng lại `tenancy_definer` như r0: gắn feature vào tên role của tenancy (X-4). (d) Vòng lặp keyset riêng trong mẫu như r0: bản sao thứ tư của cùng cơ chế, lệch ngữ nghĩa `jobId` (X-10) |
| S7-D3 | Controller → service → `UnitOfWork`. Không dùng `CommandBus` trong mẫu | Khuôn chép phải ngắn; `CommandBus` thêm hai lớp mỗi thao tác mà feature CRUD không cần. Spec cha §4.2 cho phép feature bỏ port/adapter, và SP3 dùng service | `CommandBus`/`QueryBus` như §3.3 cho mọi route: nghi thức nhiều hơn giá trị ở mẫu. Ghi amendment §3.3 là "khuyến nghị cho module nền, tuỳ chọn cho feature" |
| S7-D4 | Hai key SP4 riêng (mỗi key đúng một `kind`, SP4 §8.1): cờ `example.projects` (`FLAG`, `fallback: true`) và quota `example.project_count` (`QUOTA`, `resetPeriod: 'NONE'`, `fallback: UNLIMITED`). Quota đếm **mọi** project (cả `ACTIVE` lẫn `ARCHIVED`): `Quotas.consumeOrThrow('example.project_count', 1)` khi tạo, `Quotas.releaseAllocation('example.project_count', n)` khi xoá tay hoặc job xoá, cùng transaction | Bất biến "bộ đếm = số dòng", kiểm được bằng test. `unarchive` không đụng quota. `QUOTA` kỳ `NONE` là lựa chọn SP4 §9.5 cho tài nguyên không có khoá đếm sẵn. `fallback` rộng vì mẫu ở vùng template phải chạy với catalogue gói **của dự án**, vốn không nhắc tới nó | (a) Một key cho cả cờ và quota như r0: SP4 cấm. (b) `LIMIT` + `assertWithinLimit`: phải tự đếm dưới khoá tuần tự hoá mọi đường thêm. (c) Chỉ đếm `ACTIVE`: `unarchive` phải `consume` và có thể fail |
| S7-D5 | Cổng tính năng (`403 feature_not_in_plan`) bằng `ExampleFeatures.requireEnabled('example.projects')` (interceptor route-scoped của SP4, chạy sau mọi guard) cho `POST`/`PATCH`/archive/unarchive. `GET` và `DELETE` luôn mở | Org hạ gói vẫn xem và dọn được dữ liệu của mình | Chặn mọi route: org mất quyền truy cập dữ liệu khi hạ gói |
| S7-D6 | Mẫu nằm ở **vùng template**: `src/features/example/`, `src/migrations/example/`, `src/plans.example.ts` (catalogue gói khởi đầu, nội dung do SP4 viết), `test/*/features/example/`, `deploy/values/example.yaml`. Dự án xoá vùng này lúc khởi tạo (sau khi `init` chép phần hạt giống sang vùng dự án, S7-D36); `upstream:sync` tự giữ nó ở trạng thái đã xoá | Upstream cần mẫu chạy thật để CI chứng minh boilerplate đi hết đường. Dự án không cần giữ nó | (a) Migration mẫu trong `src/migrations/app/`: upstream ghi vào vùng dự án, xung đột mỗi lần merge. (b) Mẫu ngoài `src/` (không build): CI upstream không chạy được nó |
| S7-D7 | Tách composition: `src/boilerplate.modules.ts` (vùng boilerplate) khai báo module nền, **mỗi mục là một loader** `() => import('./modules/<m>/index.js')`. `src/app.modules.ts` (vùng dự án) gọi `await composeAppModules({ disable, features, plans })` bằng top-level await (ESM, SWC `es2022`). Chỉ module đang bật được import, nên config, luật config, queue, job và cron của module bị tắt không bao giờ được đăng ký. Luật config chéo module (`composition.config.ts`) chỉ đăng ký khi đủ các module của nó đang bật. Cron tĩnh `<m>.*` của module bị tắt được gỡ khỏi Redis | Tắt module là một khoá trong `disable` và thật sự tắt được (C1): đăng ký toàn cục xảy ra lúc import (mục 0), nên cách đúng và đơn giản nhất là không import. Không phải sửa chữ ký `defineConfig`/`defineQueue`/`defineJob`/`defineCron` ở SP1–SP6. `main.*` và `app-*.module.ts` không đổi: top-level await trong `app.modules.ts` chạy xong trước khi `validateAllConfigs()` được gọi | (a) Import tĩnh như r0: module tắt vẫn đăng ký config bắt buộc, queue không handler (worker không boot), cron chạy lỗi. (b) Gắn khoá module chủ vào mọi lệnh đăng ký rồi lọc registry: đổi chữ ký của mọi `define*` ở mọi module, dễ sót một lệnh. (c) Giữ danh sách trong `app.modules.ts`: xung đột ở mọi release có module mới |
| S7-D8 | CI vùng sở hữu dùng **so cây**: với mọi path thuộc vùng boilerplate, `git ls-tree` ở `HEAD` phải trùng ở commit upstream ghi trong `.upstream/version.json`, và commit đó phải là tổ tiên của `HEAD` | Không cần mạng hay token upstream. Bắt cả sửa trực tiếp lẫn giải xung đột sai. Squash-merge làm mất quan hệ tổ tiên nên bị bắt | (a) Duyệt commit, chỉ cho commit merge có parent upstream sửa `core/`: phải tin parent nào là upstream, bỏ sót giải xung đột sai. (b) Chỉ dùng CODEOWNERS: không bắt sửa nhầm khi review lỏng |
| S7-D9 | Không có đường thoát (override) trong guard. Sửa gấp phần nền đi qua bản vá upstream (`vX.Y.Z+1`) rồi `upstream:sync` | Đường thoát làm guard thành hình thức, và bản vá không tới được dự án khác | File `.upstream/overrides`: sau vài lần dùng thì phần nền mỗi dự án một kiểu, merge sau ngày càng khó |
| S7-D10 | Phát hành upstream bằng release-please (conventional commits có sẵn trong repo), `release-type: simple`: version nằm ở `.release-please-manifest.json` (và file version của strategy `simple`), `Chart.yaml` qua `extra-files`. **Không** chạm `package.json.version` (thuộc dự án). Mỗi tag `vX.Y.Z` kèm GitHub release và `CHANGELOG.md` | Package có sẵn, được bảo trì; repo đã dùng conventional commits. `release-type: node` (r0) bump `package.json.version`, dòng đó thuộc dự án nên mỗi lần sync xung đột (M5) | (a) Viết CHANGELOG và gắn tag tay: dễ lệch. (b) changesets: hướng tới monorepo nhiều package, mỗi PR phải thêm file |
| S7-D11 | Chart nằm trong repo (`deploy/helm/saas-app`), không publish OCI | Dự án đã nhận chart qua merge upstream; thêm registry chart là thêm hạ tầng phát hành | Publish OCI lên ghcr: thêm job, quyền và phiên bản kép chart/app |
| S7-D12 | "Vai trò scheduler" = **một nhóm worker** tên `scheduler`, consume queue `maintenance`, chạy outbox relay và Bull Board. Nhóm `default` consume mọi queue **trừ** `maintenance` (env mới `WORKER_QUEUES_EXCLUDE`) và tắt relay. Quy ước cron (S7-D34): job của cron tĩnh chạy ở `maintenance` khi nó là việc dọn dẹp/tỏa ra; việc theo org chạy ở queue của module/feature. Cron nào đặt job ở queue khác (ví dụ SP5 `billing.*` nếu SP5 giữ) thì chạy ở nhóm consume queue đó. Template kiểm tĩnh độ phủ queue (HC-25) | Spec cha §1: hai process. Lịch là BullMQ Job Scheduler trong Redis, còn cron tĩnh đồng bộ idempotent ở mọi worker, nên không có process scheduler để tách. Tách nhóm cho bulkhead thật: tồn đọng nghiệp vụ không làm trễ relay và cron dọn dẹp. `…_EXCLUDE` làm queue mới của dự án tự có consumer, không phải liệt kê | (a) Entrypoint thứ ba `main.scheduler.ts`: trái §1, không có việc riêng. (b) Liệt kê queue của nhóm `default` bằng `WORKER_QUEUES`: quên thêm queue mới thì job nằm im. (c) Chỉ một nhóm: không có bulkhead như đã yêu cầu |
| S7-D13 | Không `ServiceMonitor`. Chart nối OTel bằng env (`OTEL_*`, `OTEL_RESOURCE_ATTRIBUTES` từ downward API), có tuỳ chọn đẩy tới collector trên node qua `status.hostIP` | App đẩy metric bằng OTLP, không có endpoint `/metrics`; collector của dự án tự xuất sang Prometheus nếu cần | Thêm `@opentelemetry/exporter-prometheus` và `ServiceMonitor`: thêm dependency, thêm một đường telemetry thứ hai, lệch ADR 0014 |
| S7-D14 | Chart **không bao giờ** sinh `Secret`. Mỗi khoá secret là một dòng `secretKeyRef` tới Secret đã có sẵn (External Secrets, Sealed Secrets hay CSI do dự án chọn). Allowlist vai trò là file **sinh từ code** `deploy/helm/saas-app/files/secret-env.json` (S7-D33), `_helpers.tpl` đọc bằng `.Files.Get … \| fromJson` | Secret không nằm trong values, release history hay Git; mỗi vai trò chỉ nhận thứ nó cần (§11 quyền tối thiểu); danh sách không lệch khỏi luật config vì cùng một nguồn | (a) `envFrom` cả Secret: mọi vai trò nhận mọi secret. (b) Chart tạo Secret từ values: secret nằm trong file values và release secret của Helm. (c) Bảng viết tay trong `_helpers.tpl` như r0: lệch với luật config (C2) |
| S7-D15 | Migration là Job hook `pre-install,pre-upgrade`, weight 0, `hook-delete-policy: before-hook-creation`, `hook-output-log-policy: hook-failed` (Helm 4.3: log của Job lỗi in ra trong output của `helm upgrade`), `backoffLimit: 0`. Env nhúng thẳng vào spec Job, không qua ConfigMap của chart. NetworkPolicy của Job cũng là hook (weight −10) | Hook chạy trước khi resource thường tồn tại, nên Job không được phụ thuộc ConfigMap hay NetworkPolicy của chính release. Giữ Job cuối để đọc log. Migration all-or-nothing, nên retry tự động không đem lại gì | (a) initContainer: chạy theo từng pod, song song. (b) Hook `post-*`: pod mới lên trước schema. (c) Sync wave của Argo: gắn với một công cụ |
| S7-D16 | NetworkPolicy bật mặc định. Egress ra internet tới `0.0.0.0/0` và `::/0` **trừ** dải riêng, link-local (gồm metadata `169.254.169.254`), CGNAT, ULA, chỉ trên đúng các cổng của `RESILIENCE_ALLOWED_PORTS` của vai trò đó (một nguồn với guard SSRF của app). Egress nội bộ khai tường minh theo nhóm: DB, PgBouncer, Redis, SMTP, OTel, object storage (S3/MinIO), clamd, IdP, cộng `extra` (danh sách rule thô) cho từng vai trò | Lớp phòng thủ thứ hai cho SSRF (§11): pod bị chiếm không tới được mạng nội bộ hay metadata cloud. Nhóm có tên và `extra` cho dự án mở đường cần thiết mà không fork template vùng boilerplate | Tắt mặc định: dự án quên bật. Cổng internet riêng trong values như r0: lệch với guard SSRF, hỏng thành timeout thay vì `422` |
| S7-D17 | Worker autoscale: HPA theo CPU mặc định, cộng tuỳ chọn metric `External` (ví dụ `queue_oldest_job_age_seconds` qua adapter do dự án cài). Không KEDA | HPA v2 không cần CRD; adapter là lựa chọn của cụm | KEDA: thêm operator, trùng credential Redis |
| S7-D18 | Cửa vào: template tuỳ chọn `HTTPRoute` (Gateway API v1) và `Ingress`, mặc định tắt cả hai | Gateway API là hướng hiện tại (ingress-nginx đã dừng bảo trì tháng 3/2026); vẫn giữ `Ingress` cho cụm cũ | Chỉ `Ingress` |
| S7-D19 | Kiểm chart bằng `helm lint --strict` + kubeconform (Kubernetes 1.34 và 1.37, CRD catalog) + test render bằng Vitest (`yaml`) + kind smoke với PSA `restricted` | Vitest đã là test runner. PSA `restricted` trên kind chứng minh bảo mật lúc chạy bằng chính admission của Kubernetes | (a) Plugin helm-unittest: thêm plugin Go, trùng vai trò với Vitest. (b) chart-testing (`ct`): cần Python cộng cụm, kind job đã bao |
| S7-D20 | Kiểm chữ ký image lúc admission: file mẫu `deploy/policy/kyverno-verify-image.yaml` (`ImageValidatingPolicy`, cosign keyless, identity là workflow `release.yml` của repo). Không đặt trong chart | Đây là tài nguyên cấp cụm, không thuộc chart của app. Kyverno phát hành đều (1.19.1, 2026-09-10) | (a) sigstore policy-controller: bản cuối 2026-03. (b) Policy trong chart: app chart không được tạo tài nguyên cấp cụm |
| S7-D21 | Xoay khoá `FieldCipher`: core có registry "tập trường mã hoá" (marker Discovery `@EncryptedFieldSetContributor`) cộng cron `core.security.reencrypt` tự chạy **mỗi giờ**; keyring chỉ có một kid thì bỏ bước quét ghi lại (không có gì để ghi lại), chỉ đếm. Tập nào cột bất biến (`email_deliveries.recipient_enc`) khai `mode: 'EXPIRE'` và chỉ được đếm | Tự động, idempotent (compare-and-swap). Runbook chỉ còn thêm kid, đổi active, chờ gauge về 0, bỏ kid | (a) CLI một lần: dễ quên, không có gauge. (b) Cấp `UPDATE` cho `recipient_enc`: phá bất biến snapshot của SP2 |
| S7-D22 | Secret của Better Auth có version: config `AUTH_SECRETS` + `AUTH_SECRET_CURRENT_VERSION` truyền vào `options.secrets`; `BETTER_AUTH_SECRET` còn là secret cũ (legacy). Cùng registry S7-D21, tập `identity.better-auth-secrets` mã hoá lại 2FA và JWKS. Có spike T7-1 kèm fallback | Xoay mà không mất 2FA. Khi secret bị lộ nhưng DB thì không, mã hoá lại dưới secret mới là đủ | Giữ một secret: xoay thì mọi secret 2FA và private key JWKS thành không giải mã được (README SP2 đã ghi) |
| S7-D23 | Thao tác queue lúc sự cố dùng CLI `pnpm queue:admin` (`stats`, `retry-failed`, `pause`, `resume`). Lệnh ghi cần `--ticket`, TTY và xác nhận tương tác; `stats` chỉ đọc, không cần TTY. `retry-failed` dựng trên API thật của BullMQ 6.3.8 (mục 6.5) | SP2 chốt Bull Board read-only; runbook tồn đọng cần retry và pause | Bật thao tác ghi trên Bull Board: mở bề mặt HTTP ghi cho nhân viên |
| S7-D24 | Migrator lấy `pg_try_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)` trên **một `pg.Client` riêng** (cùng thông số kết nối owner, `keepAlive`), mở trước `MikroORM.init` và giữ suốt lượt chạy; `finally` mở khoá rồi `end()`. Không lấy được thì exit 1 với thông điệp rõ | Khoá phiên phải nằm trên một phiên sống suốt lượt chạy. Trên connection mượn từ pool (r0) khoá có thể mất khi pool đóng connection rảnh, và `unlock` có thể chạy trên connection khác | (a) Khoá qua `orm.em` như r0: sai như trên. (b) Dựa vào khoá catalog: lỗi mơ hồ, tuỳ thứ tự |
| S7-D25 | `main.migrate.ts` chỉ nạp và validate config `app`, `logging`, `database`. Migrate chỉ cần secret `DB_OWNER_PASSWORD`. Luật nào của ba namespace đó đòi thứ migrate không có thì được sửa cho biết vai trò (mục 6.5) | Quyền tối thiểu: Job migrate không cầm Redis, khoá mã hoá hay mật khẩu `app_user` | Giữ `all-configs`: migrate phải nhận `REDIS_URL` và `FIELD_ENCRYPTION_KEYS` dù không dùng |
| S7-D26 | Runbook có test chống lệch (RB-1): mọi token trong backtick dạng env, metric, script, CLI phải có thật | Runbook sai lúc 3 giờ sáng còn tệ hơn không có | Không kiểm: runbook lệch dần theo code |
| S7-D27 | Quy ước định danh của dự án: bảng, env, event, queue, job, mã lỗi, resource quyền đều mang tiền tố tên feature (`example_`, `EXAMPLE_`, `example.`). Trùng lặp đã fail lúc boot hoặc lúc migration; SP3 thêm kiểm trùng route | Tránh đụng tên với module upstream tương lai; lỗi lộ ra ở CI của lần merge, không phải ở production | Schema Postgres riêng cho dự án: phải sửa test catalog RLS, `search_path`, hàm definer |
| S7-D28 | Test inventory của boilerplate (`normalization-inventory`, `rls-catalog`) nạp phần khai báo của dự án bằng `import.meta.glob('test/**/features/**/*.inventory.ts')` | Dự án thêm bảng mà không sửa file test của boilerplate | Dự án sửa thẳng hằng trong test boilerplate: vi phạm vùng sở hữu, guard fail |
| S7-D29 | Chép mẫu theo checklist cộng test EX-U9 (tập định danh đã liệt kê). Không có generator | Generator là code thêm phải bảo trì và có thể tự lỗi; mẫu nhỏ | `pnpm feature:new`: để làm sau (mục 22) |
| S7-D30 | Kubernetes tối thiểu 1.34 (`kubeVersion: ">=1.34.0-0"`). Helm 4.3 là bản chính, Helm 3.22 chỉ được kiểm lint/template | 1.34 là nhánh cũ nhất còn nhận bản vá ngày 2026-09-23. Helm 3 vẫn phổ biến | Hỗ trợ 1.33 trở xuống: đã hết vá |
| S7-D31 | Luật thứ tự migration của SP3 (`migration-order.spec.ts`) áp **trong từng vùng**. Migration upstream đến muộn với timestamp cũ hơn migration của dự án là hợp lệ. Migration của dự án không `ALTER`/`DROP` đối tượng của boilerplate; nó chỉ tạo đối tượng của mình và chèn dòng catalogue/seed có FK tới bảng boilerplate (`permissions`, `plans`, `entitlement_features`…). Hai thứ tự chạy được phủ bằng hai test có sẵn: pipeline "migration up trên DB rỗng" (thứ tự theo tên, như CI) và job "upgrade path" (thứ tự production, UP-10) | MikroORM 7.2.1 chạy mọi migration chưa chạy bất kể thứ tự (đã đọc code). Dòng seed của dự án luôn có timestamp mới hơn migration tạo bảng đích, vì dự án chỉ viết nó sau khi đã nhận bảng đó | (a) Đòi timestamp tăng toàn cục: mọi lần sync upstream fail. (b) Luật "migration `app/` mới nhất > mọi migration module" (SP4 r0): fail ngay trong repo upstream ở migration module đầu tiên merge sau đó (X-6) |
| S7-D32 | Cài đặt mặc định của chart gồm: `enableServiceLinks: false`, `automountServiceAccountToken: false`, `APP_ROLE` gắn tường minh cho từng container | Service link của Kubernetes chèn biến `<SVC>_PORT`, có thể đè `DB_PORT`/`REDIS_PORT` của app. App không gọi Kubernetes API. CLI trong pod (reset 2FA, queue admin) cần `APP_ROLE` | Để mặc định của Kubernetes |
| S7-D33 | Secret được khai **trong code**: trường schema config mang `.meta({ secret: { roles: [...] } })` (Zod 4). Một hàm `secretFieldsOf(entries)` duyệt wrapper `optional`/`default`/`pipe`/`nullable` như `describeField` của `env-example.ts`. Script `pnpm chart:secrets` (nạp `all-configs` + **mọi** loader của `BOILERPLATE_MODULES`, không đọc `app.modules.ts`) sinh `files/secret-env.json` và mục `$defs.secretEnvName.enum` của `values.schema.json`; `--check` là test lệch trong CI như `env:example`. Nhãn "(secret)" của `.env.example` cũng lấy từ metadata | Một nguồn cho ba thứ phải khớp nhau: luật config, allowlist vai trò của chart và danh sách tên bị cấm trong ConfigMap. Tên secret không theo quy ước (`REDIS_URL`, `FILES_S3_ACCESS_KEY_ID`) vẫn được phủ; tham số không bí mật có chữ `PASSWORD`/`TOKEN` (`AUTH_PASSWORD_MIN_LENGTH`, `AUTH_EMAIL_TOKEN_TTL_SEC`) không bị chặn nhầm | (a) Regex tên như r0: chặn nhầm tham số thật, bỏ sót secret khác tên (I1). (b) Hằng viết tay ở chart: lệch với luật config (C2) |
| S7-D34 | Quy ước cron: job của `defineCron` tĩnh là việc dọn dẹp hoặc tỏa ra thì chạy ở `maintenance`; việc theo org chạy ở queue của module/feature. Mẫu theo đúng quy ước (cron tỏa ra của helper ở `maintenance`, job `example.projects.purge-org` ở `example`) và `docs/boilerplate/README.md` ghi nó | Nhóm `scheduler` là bulkhead thật cho cron; khớp SP3 và SP6 | Cron ở queue của feature như r0: `scheduler` không còn là nơi mọi cron chạy, trái mô tả của S7-D12 (I8c, N-2) |
| S7-D35 | Thứ tự khoá của mẫu: **dòng nghiệp vụ trước, bộ đếm sau** ở mọi đường. Tạo: `INSERT` project rồi `consumeOrThrow`; xoá tay và job xoá: `DELETE … RETURNING` rồi `releaseAllocation` | Với "consume trước, insert sau" (r0) có chu trình thật: tạo tên "a" giữ khoá bộ đếm rồi chờ ở unique index vì một transaction xoá tay đang xoá dòng "A" chưa commit; transaction xoá đó giữ dòng "A" và chờ khoá bộ đếm → `40P01` (mục 16, R7-8) | Consume trước: chu trình như trên, chỉ còn nhờ `UnitOfWork` retry `40P01` |
| S7-D36 | Tập **hạt giống** của vùng dự án: upstream chỉ được track đúng các path vùng dự án liệt kê ở `zones.json.projectSeed` (`src/app.modules.ts`, `README.md`). File khởi đầu khác mà dự án cần (`src/app.plans.ts`, migration seed `app/`) ship ở **vùng template** (`src/plans.example.ts`, `src/migrations/example/…_starter_*`); `upstream:init` chép chúng sang vùng dự án với timestamp mới | Upstream không bao giờ ghi vào vùng dự án sau khi clone khởi tạo; UP-9 kiểm được bằng máy | Để upstream ship `src/app.plans.ts` và `src/migrations/app/…` (SP4/SP5 r0): xung đột ở mọi lần sync (X-6) |

---

## 5. Spike

| # | Plan | Câu hỏi | Tiêu chí đạt | Fallback |
|---|---|---|---|---|
| T7-1 | 7C | Better Auth 1.7.6 với `secrets: [{version: 2, value: B}, {version: 1, value: A}]` và `secret` = secret legacy L. Cần trả lời bốn điều: (a) 2FA secret, backup code và private key JWKS đã mã hoá bằng L (bare-hex trước envelope) còn giải mã được qua `secretConfig.legacySecret`; (b) bản ghi mới có envelope version 2; (c) `symmetricDecrypt({ key: secretConfig, data })` rồi `symmetricEncrypt({ key: secretConfig, data })` từ `better-auth/crypto` cho ra envelope version hiện tại; (d) cookie phiên và bearer cũ bị từ chối (ký bằng `secret` hiện tại) | Test integration trên DB thật với user có TOTP: đăng nhập lại → `verify-totp` 200; `/token` ký được JWT; sau cron mã hoá lại mọi dòng có envelope `2`; bỏ `1` và L → 2FA vẫn chạy | Không đạt (a) hoặc (c): không thêm `AUTH_SECRETS`. Runbook ghi quy trình xoay có gián đoạn: mọi user bật lại 2FA, JWKS xoay mới (mục 14.7, nhánh B). Ghi ADR 0010 |
| T7-2 | 7B | Namespace kind gắn PSA `restricted`: pod của chart (api, worker, Job hook) được nhận nguyên vẹn không? `readOnlyRootFilesystem` cộng `emptyDir` `/tmp` đủ cho Node 24 distroless không? (`os.tmpdir`, cache của SWC không dùng ở runtime) | `kubectl get events` không có `FailedCreate`; `/health/ready` 200; job migrate `Complete` | Sửa template (không nới PSA) |
| T7-3 | 7B | kindnet của kind v0.33.0 có thực thi NetworkPolicy không? | Pod `curl` thử (image test) bị chặn tới `169.254.169.254` và tới Redis khi thiếu rule | Không thực thi: job kind cài Calico bản pin (thêm vào `deploy/tools.env`); không bỏ test chặn |
| T7-4 | 7B | `NodeSDK` 0.222 có đọc `OTEL_RESOURCE_ATTRIBUTES` (env detector mặc định) không? | Span tới collector test có `k8s.pod.name` | Thêm `resourceDetectors: [envDetector, …]` tường minh ở `telemetry-lifecycle.ts` (thay đổi core, ghi mục 6.5) |
| T7-5 | 7D | Postgres 18: câu `DISTINCT org_id … ORDER BY org_id LIMIT n` trên index partial `(org_id, status_changed_at) WHERE status = 'ARCHIVED'`, với seed 10.000 org × 50 project (20% `ARCHIVED`), có dùng skip scan hoặc index-only scan dưới 20 ms không? | `EXPLAIN (ANALYZE, BUFFERS)` ghi vào plan | Viết lại bằng recursive CTE "loose index scan" (`WITH RECURSIVE` lấy `min(org_id) > cursor` từng bước) |

---

## 6. Kiến trúc và ranh giới

### 6.1 Vùng sở hữu (thay §1.1 của spec cha bằng danh sách máy đọc được)

Nguồn sự thật duy nhất là `.upstream/zones.json` (vùng boilerplate). Luật khớp: **tiền tố dài nhất thắng**. Path không khớp mục nào thuộc **dự án**. CI upstream (UP-9) bắt mọi file được track trong repo upstream phải khớp tường minh một vùng, và file nào khớp vùng dự án thì phải nằm trong `projectSeed` (S7-D36), để upstream không bao giờ thêm hay sửa file mà clone coi là của dự án.

| Vùng | Path | Luật |
|---|---|---|
| **boilerplate** | `src/core/`, `src/modules/`, `src/migrations/` (trừ `app/`, `example/`), `src/main.api.ts`, `src/main.worker.ts`, `src/main.migrate.ts`, `src/app-api.module.ts`, `src/app-worker.module.ts`, `src/boilerplate.modules.ts`, `src/composition.config.ts`, `src/instrumentation.ts`, `src/shutdown.ts`, `src/scripts/`, `src/types/` (trừ `app/`), `test/` (trừ các mục dự án/template dưới), `docker/`, `Dockerfile`, `compose.yaml`, `deploy/helm/`, `deploy/policy/`, `deploy/tools.env`, `docs/adr/` (trừ `app/`), `docs/boilerplate/`, `docs/runbooks/` (trừ `app/`), `docs/upstream/`, `docs/superpowers/` (lịch sử spec/plan của upstream), `tools/`, `.upstream/zones.json`, `.github/workflows/ci.yml`, `nightly.yml`, `release.yml`, `upstream-guard.yml`, `release-please.yml`, `.github/codeql/`, `CHANGELOG.md`, `release-please-config.json`, `.release-please-manifest.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `.swcrc`, `vitest.config.ts`, `.oxlintrc.json`, `.prettierrc`, `.prettierignore`, `.dependency-cruiser.cjs`, `mikro-orm.config.ts`, `.nvmrc`, `.gitattributes`, `.pnpmfile.mjs`, `.auth-schema/` | Cây ở `HEAD` phải trùng cây ở commit upstream đã ghi (mục 13.2) |
| **dự án** | `src/features/`, `src/app.modules.ts`, `src/app.plans.ts`, `src/migrations/app/`, `src/types/app/`, `test/unit/features/`, `test/integration/features/`, `test/e2e/features/`, `deploy/values/`, `docs/app/` (spec, plan, ghi chú của dự án; gồm `docs/app/superpowers/`), `docs/adr/app/`, `docs/runbooks/app/`, `.github/workflows/app-*`, `.github/CODEOWNERS`, `.dependency-cruiser.app.cjs`, `README.md`, `compose.override.yaml`, `.upstream/version.json`, mọi path không khớp mục nào | Dự án toàn quyền. Upstream chỉ track `projectSeed` = `src/app.modules.ts`, `README.md` (S7-D36) |
| **template** | `src/features/example/`, `src/migrations/example/`, `src/plans.example.ts`, `test/unit/features/example/`, `test/integration/features/example/`, `test/e2e/features/example/`, `deploy/values/example.yaml` | Upstream sở hữu nội dung. Dự án được **xoá** (khi khởi tạo), không được sửa. `upstream:sync` giữ trạng thái đã xoá. Guard: path còn tồn tại thì phải trùng upstream (như boilerplate), path đã xoá thì bỏ qua |
| **sinh ra** | `.env.example`, `.env.infra.example`, `openapi.json`, `pnpm-lock.yaml` | Khi xung đột thì sinh lại, không sửa tay. CI kiểm lệch (đã có: `env:example`, `openapi:export`, `--frozen-lockfile`) |
| **chung** | `package.json`, `pnpm-workspace.yaml`, `renovate.json`, `.gitignore`, `.dockerignore`, `.gitleaksignore` | `package.json` và `pnpm-workspace.yaml` được kiểm theo khoá (mục 13.3). Các file còn lại giải xung đột tay theo `docs/upstream/merge.md` |

- **Upstream chuyển README:** nội dung `README.md` hiện tại chuyển sang `docs/boilerplate/README.md` (cùng các mục "Cách thêm", "CLI và runbook"). `README.md` gốc của upstream chỉ còn tên dự án cộng liên kết. Dự án thay `README.md` bằng nội dung của mình mà không xung đột về sau.
- **Điểm mở rộng cho file cấu hình của vùng boilerplate** (M5):
  - `.dependency-cruiser.cjs` nạp thêm `forbidden` từ `.dependency-cruiser.app.cjs` nếu file đó tồn tại (`fs.existsSync` rồi `require`, nối mảng). Dự án thêm luật kiến trúc mà không sửa file boilerplate.
  - Khai báo kiểu bổ sung (module augmentation) của dự án nằm ở `src/types/app/`; `tsconfig.json` đã `include: ["src", …]` nên tự được nạp.
  - Spec và plan của dự án ghi ở `docs/app/superpowers/` (`docs/boilerplate/README.md` hướng dẫn đặt vị trí spec cho quy trình superpowers của dự án). `docs/superpowers/` giữ lịch sử của upstream; guard báo path cụ thể nếu dự án ghi nhầm vào đó.
- **CODEOWNERS** là file của dự án (tên team khác nhau giữa các dự án). Upstream cung cấp `docs/upstream/CODEOWNERS.template` ánh xạ vùng boilerplate → team nền. `upstream:init` chép file này với tên team được truyền vào. Branch protection bắt review của code owner: đây là lớp chặn cố ý (mục 15), guard CI là lớp chặn nhầm.

### 6.2 Composition module (S7-D7)

**Nguyên tắc (C1):** ở codebase này, import một module là đăng ký trạng thái toàn cục của nó (config, luật config, queue, job, cron; mục 0). Vì vậy "tắt module" chỉ đúng khi module đó **không bao giờ được import**. Composition nạp module lười; không đổi chữ ký của `define*` nào.

- `src/boilerplate.modules.ts` (mới, vùng boilerplate):
  - `type ModuleEntry = { load: (opts: ComposeOptions) => Promise<{ api: ModuleImport; worker: ModuleImport }> }`. Mỗi `load` tự `import()` rồi dựng module, nên kiểu cụ thể của từng module nằm trong thân hàm và không cần `any`.
  - `export const BOILERPLATE_MODULES = { notifications: { load: async () => { const m = await import('./modules/notifications/index.js'); return { api: m.NotificationsModule.forApi(), worker: m.NotificationsModule.forWorker() }; } }, identity: …, tenancy: …, entitlements: { load: async (o) => { const m = await import('./modules/entitlements/index.js'); return { api: m.EntitlementsModule.forApi(o.plans), worker: m.EntitlementsModule.forWorker(o.plans) }; } }, … } as const satisfies Record<string, ModuleEntry>`, theo thứ tự import có nghĩa. Mục `entitlements` do plan merge sau trong cặp 7A ∥ 4A thêm (X-7, amendment D1).
  - `export type BoilerplateModuleKey = keyof typeof BOILERPLATE_MODULES`;
  - `export async function composeAppModules(opts: { disable?: readonly BoilerplateModuleKey[]; features: { api: ModuleImport[]; worker: ModuleImport[] }; plans?: PlanCatalogue }): Promise<{ api: ModuleImport[]; worker: ModuleImport[] }>`. `PlanCatalogue` là `import type` từ index của entitlements (bị xoá lúc biên dịch, không đăng ký gì).
  - **(r2, R-X13) `export const OPTIONAL_BRIDGES`**: mảng các cầu nối nạp khi **đủ** một tập module cùng bật, kiểu `{ key: string; when: readonly BoilerplateModuleKey[]; load: () => Promise<{ api: ModuleImport; worker: ModuleImport }> }[]`. 7A tạo hằng **rỗng** (test bằng mục fixture qua `composeFrom`). Dòng đầu tiên do SP4 4B thêm: `{ key: 'entitlements-files', when: ['entitlements', 'files'], load: async () => { const m = await import('./modules/entitlements/integrations/files.js'); return { api: m.EntitlementsFilesPortsModule, worker: m.EntitlementsFilesPortsModule }; } }` (adapter `FileStorageLimit` của SP4 cho files, SP4 §9.7). Cầu nối không có config, queue, job hay cron, và không gọi `markModuleLoaded` (nó không phải module). Luật kiến trúc: entry của cầu nối chỉ được import từ `src/boilerplate.modules.ts` (SP4 20.8-d).
- `composeAppModules`, theo thứ tự:
  1. Ném lỗi khi `disable` có khoá trùng hoặc khoá lạ; khi tắt một module mà module khác còn bật phụ thuộc vào (hằng `MODULE_REQUIRES` trong cùng file: `tenancy → identity`, `identity → notifications`, `entitlements → tenancy`; mỗi module SP sau tự thêm dòng của mình); khi `entitlements` bật mà thiếu `plans`.
  2. `await` tuần tự `load()` của các module đang bật (thứ tự của `BOILERPLATE_MODULES`).
  2b. (r2, R-X13) `await` tuần tự `load()` của mọi mục `OPTIONAL_BRIDGES` có `when ⊆ enabled`, theo thứ tự của mảng; mục có `when` chứa khoá lạ → ném (kiểm ở bước 1). Module của cầu nối được nối vào **cả** api lẫn worker, sau module nền. Cầu nối chỉ import index của module đã bật ở bước 2, nên bước 4 không báo gì.
  3. Gọi `registerCompositionRules(enabled)` của `composition.config.ts`.
  4. Kiểm **không module bị tắt nào đã bị import**: mỗi `modules/<m>/index.ts` gọi `markModuleLoaded('<m>')` của `core/config` ở dòng đầu (một dòng, tường minh). `loadedModules() ⊄ enabled` → ném `Module "<m>" is disabled but was imported (by a feature or another module); enable it or remove the import`. Lỗi này bắt trường hợp feature import tĩnh index của module bị tắt (ví dụ feature mẫu import `entitlements` khi `entitlements` bị tắt), thứ sẽ làm module đó đăng ký lại config/queue của nó.
  5. Ghi tập module bị tắt vào `disabledModuleKeys()` của `core/scheduler` (dùng ở mục dưới), rồi trả `{ api, worker }` = module nền đang bật + cầu nối đã nạp + `features`.
- **`loadedModules()` cho kiểm của module** (R-X13, R-X16): sau bước 4, `loadedModules()` (export ở `core/config`) bằng đúng tập module đang bật. Module dùng nó để biết module khác có bật hay không **mà không import** module đó, ví dụ `FileStorageLimitCheck` của SP6 files: `loadedModules().has('entitlements')` mà không có provider `FileStorageLimit` → không khởi động (SP6 §8.1 bước 4). Composition không tự biết port nào là bắt buộc; module chủ port tự kiểm.
- `src/composition.config.ts`: bỏ hai import tĩnh index của identity/notifications; export `registerCompositionRules(enabled: ReadonlySet<BoilerplateModuleKey>)`, chỉ gọi `defineConfigRule('notifications-retention-outlives-token-ttl', …)` khi cả `identity` lẫn `notifications` đang bật. Luật chéo module của SP sau đăng ký theo cùng mẫu (điều kiện là tập module của nó).
- `src/app.modules.ts` (vùng dự án, hạt giống): `export const APP_MODULES = await composeAppModules({ disable: [], plans: appPlans, features: { api: [ExampleModule.forApi()], worker: [ExampleModule.forWorker()] } });` (top-level await). Ở upstream, `appPlans` import từ `./plans.example.js`; `upstream:init` chép file đó thành `src/app.plans.ts` và đổi dòng import (S7-D36). `app-api.module.ts`, `app-worker.module.ts` và `main.*` không đổi: ESM đánh giá xong `app.modules.ts` (gồm `await`) trước khi `main.*` gọi `validateAllConfigs()`.
- **Cron của module bị tắt:** `StaticScheduler.sync()` gỡ thêm mọi scheduler `static-<m>.*` có sẵn trong Redis với `m ∈ disabledModuleKeys()`, cùng cách gỡ cron đã `retireCron`. Điều này dựa trên quy ước đã đúng ở mọi cron hiện có (khoá cron mang tiền tố `<module>.` hoặc `core.`), được giữ bằng test UP-12c. Job còn nằm trong queue của module bị tắt không có consumer; runbook "Tắt module" (`docs/boilerplate/README.md`): `queue-admin pause` + chờ queue rỗng trước khi tắt.
- **Migration của module bị tắt vẫn chạy** (thư mục `src/migrations/<m>/` vẫn được build): bảng rỗng có RLS, vô hại; bật lại module sau không phải xử lý thứ tự migration. README ghi rõ.
- `src/scripts/gen-env-example.ts` import `../app.modules.js` thay cho danh sách config của identity/notifications. Mọi config của module đang bật (kể cả feature) vào `.env.example`; module bị tắt không có dòng nào.
- `src/scripts/gen-chart-secrets.ts` (S7-D33) nạp `all-configs` và gọi `load()` của **mọi** mục `BOILERPLATE_MODULES`, không qua `app.modules.ts`: kết quả chỉ phụ thuộc boilerplate, giống nhau ở mọi clone. Không nạp `OPTIONAL_BRIDGES` (cầu nối không có config).
- `src/scripts/export-openapi.ts` đã dựng `AppApiModule` nên tự có route của feature.

### 6.3 Feature mẫu

#### 6.3.1 Bố cục

```
src/features/example/
  index.ts                 export ExampleModule, ExampleEvents, ExamplePermissionCatalogue, ExampleFeatures (public API)
  example.module.ts        forApi() / forWorker()
  example.config.ts        defineConfig('example', …)            (mục 11.1)
  errors.ts                defineErrorCodes (tiền tố example_)    (mục 9.4)
  events.ts                defineEvent × 5, audit: true, webhook: false (mục 10.1)
  jobs.ts                  defineQueue('example'), defineJob purge-org, defineOrgSweep (cron tỏa ra qua helper của core, mục 10.2)
  permissions.ts           definePermissionCatalogue + provider @PermissionCatalogueContributor
  entitlements.ts          ExampleFeatures = defineFeatureCatalogue(…) + provider @FeatureCatalogueContributor (mục 10.4)
  domain/project.ts        ProjectStatus, transition(), ProjectName, ProjectDescription (thuần TS)
  application/project.service.ts         create/update/archive/unarchive/remove/get/list
  application/purge-org.handler.ts       PurgeOrgHandler (job theo org)
  application/purge-archived-sweep.handler.ts  PurgeArchivedSweepHandler (handler mỏng của job quét: runner.run(def), SP6 §5.3)
  application/project-purge.participant.ts  @OrgPurgeParticipantContributor({ key: 'example.projects', order: 200 })
  infra/sql-project.repository.ts        Db.execute trên EM đang gắn (luật orm-only-in-infra)
  http/projects.controller.ts · http/schemas.ts
src/migrations/example/Migration<ts>_example_projects.ts
test/unit/features/example/…  test/integration/features/example/…  test/e2e/features/example/…
test/integration/features/example/example.inventory.ts   (S7-D28: bảng chuẩn hoá, hàm definer)
```

**Hướng phụ thuộc:** `features/example → modules/tenancy (index) → …`, `features/example → modules/entitlements (index)`, `features/example → core/* (index)`. Luật depcruise thêm `features-only-public-api-of-other-features`: feature A không import file nội bộ của feature B.

**Vị trí provider** (SP3 §8.2, INT3-5):

| Provider | `forApi()` | `forWorker()` |
|---|---|---|
| Provider catalogue quyền | có | có |
| Provider `@FeatureCatalogueContributor(ExampleFeatures)` | có | có |
| Controller | có | — |
| `ProjectService` | có | — |
| Handler job theo org (`PurgeOrgHandler`) | — | có |
| Handler job quét của helper (`PurgeArchivedSweepHandler`) | — | có |
| Participant xoá cứng | — | có |

Mẫu **không** có participant tạo org: dòng `org_entitlements` do participant tạo org của SP4 (`entitlements.provision`) lo.

#### 6.3.2 Luồng một request tạo

Theo pipeline SP4 §6.3 (bổ sung bước 6 của SP3 §7.1). Nest chạy **mọi guard trước mọi interceptor**, nên kiểm gói luôn sau CASL bất kể thứ tự viết decorator (S4-D7):

```
POST /v1/orgs/{orgId}/projects  (cookie | bearer | oak_ key)
 → PrincipalMiddleware → OrgContextMiddleware (membership, quyền hiệu lực, 404 thống nhất)
 → guard: AuthGuard → AppThrottlerGuard → OrgApiKeyConfinementGuard (APP_GUARD)
 → guard: PoliciesGuard (ExamplePermissionCatalogue.require('example_projects.write'))       ← mọi guard xong
 → interceptor: OrgScopeInterceptor (APP_INTERCEPTOR, OrgScope.run)
     → EntitlementInterceptor (route-scoped, ExampleFeatures.requireEnabled('example.projects'))  403 feature_not_in_plan
     → IdempotencyInterceptor (route-scoped, @Idempotent)   (thứ tự hai interceptor route không ảnh hưởng đúng/sai, SP4 §12.3)
 → ProjectService.create:
     uow.run(async () => {
       const p = await repo.insert({ name, description })      // 23505 example_projects_name_uq → 409
       await quotas.consumeOrThrow('example.project_count', 1) // SP4 §9.2: INSERT … ON CONFLICT DO UPDATE … WHERE used + 1 <= limit; 422 quota_exceeded
       await events.publish(ProjectCreated, { aggregate: {type:'example_project', id:p.publicId, version:1}, data:{projectId:p.publicId}, actor })
     })
 → 201 + Location + ETag
```

`INSERT` trước, `consumeOrThrow` sau (S7-D35): mọi đường của mẫu khoá dòng nghiệp vụ trước, bộ đếm sau. Hết quota thì `AppError` làm cả transaction rollback, dòng vừa chèn biến mất. Hệ quả nhỏ về thứ tự lỗi: tên trùng trả `409` trước khi biết quota.

#### 6.3.3 Chép mẫu thành feature mới (checklist nằm trong `docs/boilerplate/README.md`, mục "Tạo feature từ mẫu")

1. Chép `src/features/example` → `src/features/<f>`, `src/migrations/example/…` → `src/migrations/app/Migration<ts mới>_<f>_<entity>.ts` (tạo bằng `mikro-orm migration:create --blank --path src/migrations/app`, rồi dán thân), và ba thư mục test.
2. Đổi **đúng** tập định danh sau (EX-U9 giữ tập này đầy đủ):
   - tên bảng `example_projects`;
   - tên constraint và index `example_projects_*`;
   - hàm definer `example_orgs_with_purgeable_projects` (chữ ký `(p_after, p_limit, p_retention_sec)`, tên tham số thêm `p_retention_sec` là khoá của `extraParams`);
   - policy `example_projects_tenant`/`_definer_read`;
   - resource quyền `example_projects`;
   - event `example.project.*`;
   - queue `example`;
   - job `example.projects.purge-org`;
   - cron key (và job quét do helper tạo cùng tên) `example.projects.purge-archived`, class `PurgeArchivedSweepHandler`;
   - tiền tố `jobId` `example-purge` (id đầy đủ `example-purge-<orgId>-<slot>` do helper ghép theo luật slot của SP6 §5.3, per R-X4);
   - mã lỗi `example_*`;
   - namespace config `example` và env `EXAMPLE_*`;
   - key tính năng `example.projects` (cờ) và `example.project_count` (quota);
   - participant key `example.projects` (order: lấy một số chưa dùng trong dải 201–999 của registry ở addendum 3D §A4, per R-X5, R-X12; registry từ chối `order ≥ 1000` lúc boot; mẫu dùng 200);
   - metric `example_projects_purged_total`;
   - aggregate type `example_project`;
   - route `projects`;
   - class `Example*`/`Project*`.
3. Đăng ký module trong `src/app.modules.ts` (`features.api`/`features.worker`).
4. Khai báo inventory ở `test/integration/features/<f>/<f>.inventory.ts`.
5. Đặt giá trị thật cho key tính năng mới trong `src/app.plans.ts` (catalogue gói của dự án). Mẫu dùng `fallback` rộng (cờ bật, quota `UNLIMITED`) để chạy với mọi catalogue gói; feature thật chọn `fallback` an toàn cho nghiệp vụ của mình (SP4 S4-D3).
6. Chọn cờ event cho từng event (per R-X3, không có mặc định): `audit: true` nếu thao tác cần dấu vết (mẫu: cả năm event); `webhook: true` chỉ khi muốn event thành hợp đồng công khai cho khách (mẫu: `false`).
7. Quyền mới cấp cho `ADMIN` (`grantTo.admin`) làm thay đổi `A = perms(ADMIN)` của luật 2a SP3 §8.4: role tuỳ biến do owner tạo mà trước đó tương đương admin sẽ không còn tương đương sau khi nâng cấp (admin quản lý được người giữ role đó). Ghi dòng này vào Upgrade notes của feature (X-12).
8. `pnpm env:example`, `pnpm openapi:export`, chạy đủ pipeline.
9. Xoá phần không cần. Mỗi mục bị xoá kéo theo phần đi kèm của nó:
   - cron: xoá lời gọi `defineOrgSweep`, handler job quét + `retireCron(key)`;
   - hàm definer: xoá cả policy `_definer_read` và grant cột;
   - quota: xoá mọi lời gọi `consumeOrThrow`/`releaseAllocation`, key trong `ExampleFeatures` và dòng `entitlement_features` tương ứng (theo vòng đời "deprecate → xoá" của SP4 §8.4 nếu đã deploy).

#### 6.3.4 Khởi tạo dự án (xoá mẫu)

`pnpm upstream:init --team-core <team> --team-app <team>` làm các việc sau:
- ghi `.upstream/version.json` (tag hiện tại + commit);
- chép phần hạt giống từ vùng template sang vùng dự án (S7-D36): `src/plans.example.ts` → `src/app.plans.ts`; mỗi `src/migrations/example/*_starter_*.ts` (hôm nay chỉ có SP4 `_starter_plans`) → `src/migrations/app/Migration<timestamp mới>_starter_*.ts` với tên lớp khớp tên file mới (tạo bằng `mikro-orm migration:create --blank` rồi dán thân, thứ tự giữ như bản gốc). Upstream **không** ship migration giá: SP5 không có dòng giá nào (SP5 S5-D23), nên `init` không chép gì của billing (r2, R-X19; r1 ghi nhầm `_starter_prices`);
- `git rm -r` vùng template;
- trong `app.modules.ts`: bỏ `ExampleModule`, đổi import `./plans.example.js` → `./app.plans.js`;
- chép CODEOWNERS;
- thay `README.md` bằng khung trống của dự án;
- in ra bước tiếp theo (không tự làm): sửa `src/app.plans.ts` và migration gói theo gói thật; nếu bật billing, viết migration giá của dự án (mục dưới).

**Seed giá (tài liệu, không phải file mẫu; R-X19).** `docs/boilerplate/README.md` mục "Khởi tạo dự án" có đoạn "Seed giá cho billing": giá là dữ liệu tiền của dự án nên upstream không ship; dự án tạo `src/migrations/app/Migration<ts>_<tên>_prices.ts` bằng `mikro-orm migration:create --blank --path src/migrations/app`, chèn dòng `billing_prices` theo hình dạng và luật của SP5 (FK `billing_prices.plan_id → plans(id)` nên chạy sau migration gói của chính dự án; không `ALTER` bảng của billing, S7-D31), và theo vòng đời giá của README billing (SP5). Đoạn này trỏ tới README của SP5 cho cột và ràng buộc, không chép lại, để không có hai nguồn lệch nhau. RB-1 không áp (đây là `docs/boilerplate/`, không phải runbook).

Chạy **trước** lần deploy production đầu tiên. Nếu dự án đã deploy với migration mẫu, runbook `docs/upstream/merge.md` hướng dẫn giữ mẫu (không xoá) hoặc chạy down của migration mẫu trước khi xoá file. Down của nó từ chối khi còn dữ liệu (mục 7.5).

### 6.4 Helm chart: cấu trúc

```
deploy/helm/saas-app/
  Chart.yaml            apiVersion v2, name saas-app, version = appVersion = version boilerplate (release-please)
                        kubeVersion ">=1.34.0-0"
  values.yaml · values.schema.json (JSON Schema 2020-12; $defs.secretEnvName sinh bởi `pnpm chart:secrets`)
  files/secret-env.json         SINH RA (S7-D33): { "<ENV>": ["api"|"worker"|"migrate", …] }, không sửa tay
  templates/_helpers.tpl        tên, nhãn, env chung, env secret theo vai trò (đọc files/secret-env.json), pod securityContext,
                                kiểm budget, kiểm độ phủ queue, cổng internet từ RESILIENCE_ALLOWED_PORTS
  templates/configmap.yaml      config không bí mật dùng chung (+ checksum annotation trên pod)
  templates/serviceaccount.yaml (tuỳ chọn; mặc định tạo, automount false)
  templates/api-deployment.yaml · api-service.yaml · api-hpa.yaml · api-pdb.yaml
  templates/worker-deployment.yaml · worker-hpa.yaml · worker-pdb.yaml   (range theo workers.*)
  templates/dashboard-service.yaml   (khi một nhóm worker có dashboard: true)
  templates/migrate-job.yaml · migrate-networkpolicy.yaml   (hook)
  templates/networkpolicy.yaml
  templates/httproute.yaml · ingress.yaml   (tuỳ chọn)
  templates/NOTES.txt
  ci/values-minimal.yaml · values-full.yaml · values-kind.yaml · values-split-workers.yaml
deploy/values/example.yaml   (template: mẫu values production có chú thích)
deploy/policy/kyverno-verify-image.yaml
deploy/tools.env             HELM_VERSION, KUBECONFORM_VERSION + SHA256, KIND_VERSION, KIND_NODE_IMAGE@digest, KUBE_VERSIONS
test/deploy/chart.spec.ts    (Vitest project mới `deploy`)
test/deploy/kind/            infra.yaml (Postgres, PgBouncer, Redis, Mailpit có SMTP AUTH, mock-oauth2-server; chỉ để test,
                             image pin digest trong docker/images.env), smoke.sh (chỉ route vùng boilerplate; bước mẫu có điều kiện)
```

### 6.5 Thay đổi ở `core/`, `modules/` và file boilerplate khác

| Chỗ sửa | Thay đổi | Lý do | Plan |
|---|---|---|---|
| `core/queue/queue.config.ts`, `worker-host.ts` | Env `WORKER_QUEUES_EXCLUDE` (danh sách, mặc định rỗng). Ném lỗi lúc boot khi: cả `WORKER_QUEUES` lẫn `…_EXCLUDE` cùng khác rỗng; `…_EXCLUDE` có tên lạ; tập queue kết quả rỗng | S7-D12 | 7B |
| `src/main.migrate.ts` | Import `app.config`, `logging.config`, `database.config` thay cho `all-configs.js`. Không namespace nào khác: luật nào của ba namespace này cần namespace khác thì được sửa cho biết vai trò (dòng dưới), không nạp thêm namespace | S7-D25 | 7B |
| `core/database/database.config.ts` (C2) | (1) `appPassword` thành `.optional()`, thêm `defineConfigRule('database-app-password-required', c => c.app?.role !== 'migrate' && !c.database?.appPassword ? 'DB_APP_PASSWORD is required on api and worker' : undefined)`, cùng mẫu luật `authDatabase` đã có. (2) Luật production `database-query-deadline` trả `undefined` khi `c.app?.role === 'migrate'` (ngân sách HTTP không áp cho migrate; api và worker giữ nguyên hành vi) | Migrate chỉ nhận `DB_OWNER_PASSWORD`; không nạp `http` | 7B |
| `modules/notifications/notifications.config.ts` (C2) | `smtp-auth-pair` chỉ áp khi `c.app?.role === 'worker'` (chỉ worker gửi thư: `forApi` chỉ ghi DB + enqueue), cùng mẫu với `smtp-required-on-worker` ngay bên trên | api không nhận `SMTP_PASSWORD` | 7B |
| `modules/identity/identity.config.ts`, `infra/better-auth/auth-options.ts`, `auth-instance.ts` (C2) | (1) Chuyển cặp `AUTH_GOOGLE_CLIENT_ID`/`_SECRET` và yêu cầu `AUTH_OIDC_CLIENT_SECRET` của `hybrid` từ `superRefine` của schema sang `defineConfigRule` chỉ áp khi `c.app?.role === 'api'`; phần không bí mật của `hybrid` (`AUTH_OIDC_PROVIDER_ID`, `_DISCOVERY_URL`, `_CLIENT_ID`) giữ bắt buộc ở mọi vai trò như cũ. (2) `auth-options.ts` chỉ dựng `socialProviders.google` và plugin `genericOAuth` khi `app.role === 'api'`. (3) `assertAuthProvidersRegistered` chỉ kỳ vọng provider OIDC khi vai trò là api | Worker không phục vụ route OAuth/OIDC; không cần client secret, và không còn gọi discovery của IdP lúc boot (bớt một đường egress) | 7B |
| `core/config/` (S7-D33) | Hàm `secretFieldsOf(entries): { env: string; roles: readonly AppRole[] }[]` đọc `.meta().secret` qua các wrapper như `describeField`; `renderEnvExample` lấy nhãn "(secret)" từ metadata. Mọi trường secret của core/SP2 được đánh dấu: `DB_APP_PASSWORD` (api, worker), `DB_AUTH_PASSWORD` (api, worker), `DB_RELAY_PASSWORD` (worker), `DB_OWNER_PASSWORD` (migrate), `REDIS_URL` (api, worker), `FIELD_ENCRYPTION_KEYS` (api, worker), `BETTER_AUTH_SECRET` (api, worker), `AUTH_GOOGLE_CLIENT_SECRET` (api), `AUTH_OIDC_CLIENT_SECRET` (api), `SMTP_PASSWORD` (worker); `AUTH_SECRETS` (api, worker) ở 7C. Test unit: trường có `secret` mà luật nào đòi nó ở vai trò ngoài `roles` → CO-4 bắt | Một nguồn cho luật config, allowlist chart và tên cấm trong ConfigMap | 7B |
| `src/scripts/gen-chart-secrets.ts` (mới), script `"chart:secrets"` | Sinh `deploy/helm/saas-app/files/secret-env.json` và `$defs.secretEnvName.enum` trong `values.schema.json` (đọc JSON, thay đúng một khoá, ghi lại có định dạng ổn định); `--check` fail khi khác. CI chạy `--check` cạnh `env:example` | S7-D33 | 7B |
| `core/database/migrator.ts` | Trước `MikroORM.init`: mở `new pg.Client({ host: migrationHost, port: migrationPort, database, user: ownerUser, password: ownerPassword, ssl: tlsOptions(db), keepAlive: true })`, `connect()`, `SELECT pg_try_advisory_lock($1)` với hằng `MIGRATION_ADVISORY_LOCK_KEY` (bigint có tên). `false` → log ERROR `migration_lock_busy`, ném `Another migration run holds the migration lock` (exit 1). Giữ client suốt lượt chạy; `finally` (sau `orm.close`): `SELECT pg_advisory_unlock($1)` (kết quả `false` → log ERROR, không nuốt), rồi `client.end()` ở mọi nhánh, kể cả khi `connect` hay `unlock` lỗi. (Review plan 7B, I2, I4) Mọi phiên của migrator (pool ORM và phiên khoá) đặt `options: -c client_connection_check_interval=<MIGRATION_CLIENT_CHECK_INTERVAL_MS>` để backend tự huỷ câu đang chạy khi client chết (SIGKILL, mất TCP), thay vì chạy tiếp tới lần I/O sau; phiên khoá thêm `-c idle_session_timeout=0` và `keepAliveInitialDelayMillis` nhỏ (hằng có tên); `client.on('error')` log `migration_lock_session_lost` và huỷ lượt chạy tường minh (`MigrationLockLostError`, đóng pool ORM). Pool ORM của migrator `max = MIGRATION_ORM_POOL_MAX = 1` (allOrNothing chạy trong một transaction), nên phần Postgres trực tiếp của migrate là đúng 2 connection | S7-D24. Migrator nối thẳng Postgres (Ruling R8), nên khoá phiên dùng được; client riêng bảo đảm khoá sống đúng bằng lượt chạy. Process chết thì phiên đóng, khoá tự nhả | 7B |
| `core/queue/queue-admin.ts` (mới, export), `src/scripts/queue-admin.ts` (entry), script `"queue:admin": "node dist/scripts/queue-admin.js"` | Lệnh:<br>• `stats`: với mỗi queue đã đăng ký, `getJobCounts('wait','active','delayed','prioritized','waiting-children','failed')` + `isPaused()`. Chỉ đọc, **không** đòi TTY hay `--ticket` (chạy được từ `smoke.sh` không `-t`).<br>• `pause --queue <q>` / `resume --queue <q>`: `Queue.pause()`/`resume()`.<br>• `retry-failed --queue <q> [--job <name>] [--max <n>]`: có `--job` hoặc `--max` thì (1) chụp danh sách id: đọc `getJobs(['failed'], start, start + PAGE - 1, true)` theo trang (`QUEUE_ADMIN_PAGE_SIZE` = 500, hằng có tên), lọc `job.name === <name>`, dừng khi đủ `--max` hoặc hết trang; (2) với từng job: `job.retry('failed')`; thành công → `affected++`, ném (job không còn `failed`, đang khoá, đã bị dọn) → `skipped++`. Không có cả hai cờ thì `Queue.retryJobs({ state: 'failed' })` và log `affected: null` (API không trả số lượng).<br>Ba lệnh ghi: `--ticket` bắt buộc; TTY bắt buộc (không TTY thì exit 1 như lệnh reset của SP3); xác nhận tương tác (gõ lại tên queue). Log WARN `{ event: 'queue_admin', action, queue, job?, ticket, affected, skipped }`; counter `queue_admin_actions_total{action}` | S7-D23. Chỉ `core/queue` được import BullMQ. Chụp id trước rồi mới retry: trang không bị xê dịch vì job rời trạng thái `failed` giữa lúc đọc | 7E |
| `core/security/` | Port `EncryptedFieldSet` + marker `@EncryptedFieldSetContributor({ key, keyring: 'field' \| 'auth', mode: 'REWRITE' \| 'EXPIRE' })` + `EncryptedFieldSetRegistry` (quét `DiscoveryService` trong `onModuleInit`, key trùng → ném) + job/cron `core.security.reencrypt` (queue `maintenance`, mặc định mỗi giờ; keyring một kid thì chỉ đếm, không quét ghi lại) + gauge `encrypted_rows` + counter `encrypted_rows_undecryptable_total` | S7-D21 (mục 10.5) | 7C |
| `modules/identity` | Tập `identity.account-tokens` (`auth.account`: `access_token`, `refresh_token`, `id_token`; AAD như SP2; `REWRITE`). Sau T7-1: config `AUTH_SECRETS`/`AUTH_SECRET_CURRENT_VERSION` truyền `secrets`; tập `identity.better-auth-secrets` (`auth.two_factor.secret`, `.backup_codes`, `auth.jwks.private_key`; keyring `auth`; `REWRITE`); luật "bắt buộc `BETTER_AUTH_SECRET` trừ khi có `AUTH_SECRETS`" | S7-D21, S7-D22 | 7C |
| `modules/notifications` | Tập `notifications.email-deliveries` (`recipient_enc`, `params_enc`; `EXPIRE`: chỉ đếm, dòng tự mất sau `NOTIFICATIONS_RETENTION_DAYS`) | S7-D21 | 7C |
| `src/boilerplate.modules.ts` (mới, gồm `BOILERPLATE_MODULES`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES` rỗng), `src/app.modules.ts` (top-level await), `src/composition.config.ts` (`registerCompositionRules`), `src/scripts/gen-env-example.ts` | Mục 6.2 | S7-D7; `OPTIONAL_BRIDGES` theo R-X13 | 7A |
| `core/config/` (C1) | `markModuleLoaded(key)`/`loadedModules()` (tập trong process, export ở `core/config/index.ts`); mỗi `modules/<m>/index.ts` gọi `markModuleLoaded('<m>')` ở dòng đầu (identity, notifications, tenancy ở 7A; SP4, SP5, SP6 nhận nghĩa vụ này cho module của mình, per R-X16). `loadedModules()` cũng là cách module kiểm module khác có bật mà không import nó (SP6 `FileStorageLimitCheck`, R-X13) | S7-D7 bước 4 | 7A |
| `core/scheduler/static-scheduler.ts`, `cron-definition.ts` (C1) | `setDisabledModuleKeys(keys)`/`disabledModuleKeys()`; `sync()` gỡ thêm scheduler `static-<m>.*` với `m` bị tắt. Quy ước "cron của module `m` có khoá `m.*`" được giữ bằng test UP-12c (nạp riêng từng module, mọi cron nó đăng ký phải có tiền tố `<m>.`) | S7-D7 | 7A |
| `test/integration/core/database/normalization-inventory.spec.ts`, `rls-catalog.spec.ts` (SP3 mở rộng) | Nạp `import.meta.glob('../../../**/features/**/*.inventory.ts', { eager: true })`. Mỗi file export `{ tables?: NormalizationEntry[], globalTables?: string[], definerFunctions?: string[], definerReadTables?: string[] }`, gộp vào hằng của boilerplate; trùng → test fail | S7-D28 | 7A (normalization), 7D (rls-catalog, sau SP3) |
| `.dependency-cruiser.cjs` | Nạp `.dependency-cruiser.app.cjs` nếu có (7A, M5); luật `features-only-public-api-of-other-features` + fixture phải fail (7D) | 6.1, 6.3.1 | 7A, 7D |
| `vitest.config.ts` | Project `deploy` (`test/deploy/**/*.spec.ts`) | 6.4 | 7B |
| `docs/boilerplate/README.md` (chuyển từ `README.md`) | Mục 6.1; "Tắt module"; quy ước cron (S7-D34); chép mẫu (6.3.3) | S7-D6 | 7A |

Không đổi hành vi nào khác của SP1–SP3. Test SP1–SP3 phải sửa:
- `test/unit/core/queue/*` thêm ca `…_EXCLUDE`;
- test migrator thêm ca khoá;
- test `gen-env-example` (nếu có) đổi nguồn;
- `test/unit/modules/identity/identity-config.spec.ts`: ca cặp Google/OIDC chuyển sang luật theo vai trò (api vẫn đòi; worker không);
- test của notifications có ca `smtp-auth-pair` thêm vai trò;
- `.env.example` sinh lại (thêm `WORKER_QUEUES_EXCLUDE`, env `EXAMPLE_*`, nhãn "(secret)" từ metadata).

---

## 7. Mô hình dữ liệu (feature mẫu)

Chỉ một bảng tenant, một hàm definer và dữ liệu catalogue.

### 7.1 `example_projects`

```sql
CREATE TABLE example_projects (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         UUID        NOT NULL DEFAULT uuidv7(),
  org_id            UUID        NOT NULL,
  name              TEXT        NOT NULL,
  description       TEXT        NULL,
  status            TEXT        NOT NULL DEFAULT 'ACTIVE',
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INT         NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT example_projects_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT example_projects_org_public_uq UNIQUE (org_id, public_id),
  CONSTRAINT example_projects_name_ck CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT example_projects_description_ck CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
  CONSTRAINT example_projects_status_ck CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT example_projects_version_ck CHECK (version >= 1)
);
CREATE UNIQUE INDEX example_projects_name_uq ON example_projects (org_id, lower(name));
CREATE INDEX example_projects_list_idx ON example_projects (org_id, created_at DESC, id DESC);
CREATE INDEX example_projects_purge_idx ON example_projects (org_id, status_changed_at) WHERE status = 'ARCHIVED';
```

- **Độ dài** 100 và 1000 là hằng có tên `EXAMPLE_PROJECT_NAME_MAX_LENGTH`, `EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH`, dùng chung giữa zod và `CHECK`. Migration viết cứng hai số này vì không import code; test EX-I7 so `pg_get_constraintdef` với hằng, theo mẫu `email_templates = TEMPLATE_KEYS` của SP3.
- **`description` rỗng:** client gửi `""` thì zod chuẩn hoá thành `null`. DB không nhận chuỗi rỗng, nên "không có mô tả" chỉ có một cách biểu diễn.
- **Không có `UNIQUE (org_id, id)`** vì không có bảng con. Checklist 6.3.3 ghi: bảng có con phải thêm constraint này và FK kép (ADR 0005).
- **Mỗi index gắn với một query:**

  | Index | Query |
  |---|---|
  | `example_projects_org_public_uq` | tra theo `(org_id, public_id)` ở mọi route có `{projectId}`; đồng thời phủ FK `org_id` |
  | `example_projects_name_uq` | bất biến tên không trùng (không phân biệt hoa thường) trong org |
  | `example_projects_list_idx` | `GET …/projects` với `ORDER BY created_at DESC, id DESC`. Lọc `?status=` chạy trên cùng index: số dòng mỗi org bị quota chặn, offset ≤ `PAGINATION_MAX_OFFSET_ROWS` |
  | `example_projects_purge_idx` | job xoá theo org (7.4) và hàm definer (7.3) |

  Plan 7D kèm `EXPLAIN (ANALYZE, BUFFERS)` cho bốn câu trên seed ở T7-5.

**RLS và grant** (cùng migration):

```sql
ALTER TABLE example_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY example_projects_tenant ON example_projects TO app_user
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY example_projects_definer_read ON example_projects FOR SELECT TO sweep_definer USING (true);
GRANT SELECT, INSERT, DELETE ON example_projects TO app_user;
GRANT UPDATE (name, description, status, status_changed_at, version, updated_at) ON example_projects TO app_user;
GRANT SELECT (org_id, status, status_changed_at) ON example_projects TO sweep_definer;
```

- `org_id`, `id`, `public_id`, `created_at` không có grant `UPDATE` (quy ước SP3 §6.1).
- `app_user` có `DELETE` vì cả ba đường xoá chạy bằng `app_user` trong `OrgScope`: xoá tay, job xoá, participant xoá cứng org.
- Role đọc chéo org là `sweep_definer` (SP6 6.0, per R-X4), không phải `tenancy_definer`. Hậu tố policy `_definer_read` theo đề xuất X-4 (một hậu tố cho mọi policy definer); nếu SP6 r1 chốt hậu tố khác cho policy của `sweep_definer`, 7D theo SP6 (chỉ đổi tên policy và dòng inventory).
- Grant cột cho `sweep_definer` giới hạn đúng ba cột mà hàm definer đọc.

### 7.2 Dữ liệu catalogue quyền

Trong cùng migration, bảng global không FORCE, `app_owner` ghi trực tiếp:

```sql
INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
  ('example_projects', 'read',   false, true,  true),
  ('example_projects', 'write',  false, true,  false),
  ('example_projects', 'delete', false, false, false);
INSERT INTO permission_requires (permission_id, required_permission_id)
  SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'example_projects.read'
  WHERE p.key IN ('example_projects.write', 'example_projects.delete');
```

Catalogue trong code (`permissions.ts`) phải khớp từng cờ. `CatalogueCheck` của SP3 dừng boot khi lệch.

| Key | requires | ownerOnly | apiKey | support | ADMIN | MEMBER |
|---|---|---|---|---|---|---|
| `example_projects.read` | — | | ✓ | ✓ | ✓ | ✓ |
| `example_projects.write` | `read` | | ✓ | | ✓ | ✓ |
| `example_projects.delete` | `read` | | | | ✓ | |

**Dòng tính năng SP4** (bắt buộc: `EntitlementCatalogueCheck` của SP4 §8.3 dừng boot khi catalogue code khác `entitlement_features`). Cùng migration, bảng global không FORCE (SP4 §7.1), `app_owner` ghi trực tiếp:

```sql
INSERT INTO entitlement_features (key, kind, reset_period) VALUES
  ('example.projects',      'FLAG',  NULL),
  ('example.project_count', 'QUOTA', 'NONE');
```

Khớp `ExampleFeatures` trong `entitlements.ts`:

```ts
export const ExampleFeatures = defineFeatureCatalogue({
  'example.projects':      { kind: 'FLAG',  fallback: true,                             description: 'Projects (sample feature)' },
  'example.project_count': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: UNLIMITED,  description: 'Number of projects' },
});
```

Hai key khớp `FEATURE_KEY_PATTERN` của SP4 (`<module>.<tên>`, chữ thường, `_`). Mẫu không chèn gì vào `plans` hay `usage_counters`: giá trị theo gói nằm ở catalogue gói của dự án (6.3.3 bước 5), dòng bộ đếm do SP4 tạo lười ở lần consume đầu.

### 7.3 Hàm definer cho cron

```sql
SET LOCAL ROLE sweep_definer;
CREATE FUNCTION public.example_orgs_with_purgeable_projects(p_after uuid, p_limit integer, p_retention_sec integer)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_retention_sec IS NULL
     OR p_limit < 1 OR p_limit > 1000 OR p_retention_sec < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'example_orgs_with_purgeable_projects: argument out of range';
  END IF;
  RETURN QUERY
    SELECT DISTINCT p.org_id FROM public.example_projects p
    WHERE p.status = 'ARCHIVED'
      AND p.status_changed_at <= now() - make_interval(secs => p_retention_sec)
      AND p.org_id > p_after
    ORDER BY p.org_id
    LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer) TO app_user;
RESET ROLE;
```

- **Chữ ký theo R-X14 (r2):** `(p_after uuid, p_limit integer, p_retention_sec integer)`: hai tham số đầu là chữ ký cố định của helper `defineOrgSweep` (SP6 §5.3), tham số nghiệp vụ đứng sau và được helper truyền **theo tên** (`p_retention_sec => $3::integer`). r1 đặt `p_retention_sec` ở giữa, nên runner (gọi theo vị trí ở SP6 r1) truyền `limit` vào `p_retention_sec` và retention (2 592 000) vào `p_limit`: nhánh `p_limit > 1000` `RAISE` ở mọi lượt và cron mẫu không bao giờ chạy (review X2-2). Hàm có đúng một overload (test `org-sweep-signatures.spec.ts` của SP6 đọc `pg_proc`). `REVOKE`/`GRANT` giữ kiểu `(uuid, integer, integer)`.
- Số `1000` là `DEFINER_LIMIT_MAX` (hằng export từ `core`, X-4; migration viết cứng vì không import code, EX-I8 so với hằng). Con trỏ và giới hạn lô do helper quét quản lý (mục 10.2); hàm nhận `p_after`/`p_limit` theo đúng quy ước keyset của SP3 §6.14, cộng tham số nghiệp vụ `p_retention_sec` (số nguyên giây; hàm tự dựng `interval`).
- Hàm chỉ trả `org_id`; không cột nghiệp vụ nào ra khỏi phạm vi org.
- Migration mở đầu bằng kiểm role `sweep_definer` tồn tại (không có thì `RAISE`), như 3A kiểm `tenancy_definer`.

### 7.4 Câu xoá của job theo org

Chạy bằng `app_user`, trong `OrgScope(orgId)` và `UnitOfWork`:

```sql
WITH due AS (
  SELECT id FROM example_projects
  WHERE org_id = ? AND status = 'ARCHIVED'
    AND status_changed_at <= clock_timestamp() - make_interval(secs => ?)
  ORDER BY status_changed_at, id
  LIMIT ?
  FOR NO KEY UPDATE SKIP LOCKED
)
DELETE FROM example_projects p USING due WHERE p.id = due.id
RETURNING p.public_id, p.version;
```

- **`clock_timestamp()`** vì đây là so sánh sau khi lấy khoá (SP3 §3.15).
- **`FOR NO KEY UPDATE`** theo SP3 §3.13.
- **`SKIP LOCKED`:** dòng đang bị `unarchive`/`PATCH` giữ thì để lần sau (race R7-5).
- **`org_id = ?`** lấy từ `RequestContext`: tường minh để dùng index, song song với policy RLS.
- Cùng transaction, **sau** câu xoá (S7-D35):
  - `quotas.releaseAllocation('example.project_count', rows.length)` khi `rows.length > 0` (SP4 §9.3: chỉ `QUOTA` kỳ `NONE`; `used < n` → `QuotaReleaseUnderflowError`, fail loud);
  - một event `example.project.deleted { projectId, reason: 'RETENTION' }` cho mỗi dòng (`aggregate.version` = `version + 1`, xem mục 10.1).
- Xoá tay (`DELETE …/projects/{id}`) theo cùng thứ tự: `DELETE … WHERE public_id = ? RETURNING …` (0 dòng → `404`), rồi `releaseAllocation(…, 1)`, rồi event `REMOVED`.

### 7.5 Migration, khoá, down

Một file `src/migrations/example/Migration<ts>_example_projects.ts`. Timestamp lớn hơn mọi migration của SP3/SP4 trên `main` lúc merge (luật SP3 §6.13 trong vùng boilerplate/template).

| Up | Khoá (giữ tới hết lô) | Down |
|---|---|---|
| kiểm role `sweep_definer`; `CREATE TABLE`, index, RLS, policy, grant; dòng catalogue quyền; hai dòng `entitlement_features`; hàm definer dưới `SET LOCAL ROLE sweep_definer` | `SHARE ROW EXCLUSIVE` trên `organizations` (FK, ngắn); `ROW EXCLUSIVE` trên `permissions`, `permission_requires`, `entitlement_features` | Xem các bước dưới |

Các bước của `down`, theo thứ tự:
1. `ALTER TABLE example_projects NO FORCE ROW LEVEL SECURITY` (bảng của chính mẫu).
2. `DO $$ BEGIN IF EXISTS (SELECT 1 FROM example_projects) THEN RAISE EXCEPTION 'example_projects is not empty: delete projects or keep the migration'; END IF; END $$`. Down không bao giờ âm thầm xoá dữ liệu nghiệp vụ.
3. `SET LOCAL ROLE sweep_definer; DROP FUNCTION …; RESET ROLE`.
4. `DROP TABLE example_projects`.
5. Xoá dòng `permission_requires` rồi `permissions` của ba key. FK `RESTRICT` từ `org_role_permissions`/`org_api_key_permissions`/`org_support_grant_permissions` làm down fail to khi còn role tuỳ biến, key hoặc grant giữ các quyền này. Runbook ghi: thu hồi trước, hoặc theo vòng đời "deprecate → xoá" của SP3 §8.8.
6. `DELETE FROM entitlement_features WHERE key IN ('example.projects', 'example.project_count')`. FK `RESTRICT` từ `usage_counters`/`org_entitlement_overrides` (SP4 §7.4–7.5) làm down fail to (`23503`) khi org nào đã từng có bộ đếm hay override cho hai key này. Down **không** `NO FORCE` bảng của SP4 để tự xoá các dòng đó (migration của vùng template/dự án không `ALTER` đối tượng boilerplate, S7-D31). Runbook: gỡ tính năng đã dùng theo vòng đời "deprecate → xoá" của SP4 §8.4 (bước xoá bộ đếm/override là migration của chủ tính năng theo mẫu 7 bước SP3 §8.8), rồi mới chạy down này. Cả `down` chạy trong một transaction (`allOrNothing`), nên fail ở bước 5 hay 6 để DB y nguyên.

Khối khẳng định FORCE ở cuối (SP3 §8.8 bước 7) không cần: bảng đã bị xoá trong cùng `down`. Test quét tĩnh của SP3 (`CREATE FUNCTION`/`DROP FUNCTION` đối xứng, `SET LOCAL ROLE`/`RESET ROLE`, không `isTransactional`) chạy trên thư mục `example/`.

### 7.6 Bảng chuẩn hoá

| Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng chuẩn | Ngoại lệ |
|---|---|---|---|---|
| `example_projects` | `{id}`; `{org_id, public_id}`; `{org_id, lower(name)}` (khoá biểu thức, ép bằng unique index) | Mỗi khoá → mọi cột. `status` không suy ra được từ `status_changed_at`, và ngược lại (không dùng cột `archived_at` riêng vì nó sẽ tạo phụ thuộc `archived_at → status`, vi phạm 3NF) | BCNF | Không có. `org_id` là thuộc tính của chính dòng (neo tenant), không lặp từ bảng cha nào |
| `permissions`, `permission_requires` | như SP3 §6.12 | như SP3 | như SP3 | chỉ thêm dòng |
| `entitlement_features` | như SP4 §7.6 | như SP4 | như SP4 | chỉ thêm dòng |

Inventory ở `example.inventory.ts` liệt kê mọi cột, nên `normalization-inventory.spec.ts` fail khi có cột chưa phân tích (S7-D28).

---

## 8. State machine

### 8.1 `Project` (`domain/project.ts`)

```
(không tồn tại) --create--> ACTIVE --archive--> ARCHIVED --unarchive--> ACTIVE
ACTIVE | ARCHIVED --remove--> (xoá)          ARCHIVED --purge (quá retention)--> (xoá)
```

`type ProjectStatus = 'ACTIVE' | 'ARCHIVED'`; `type ProjectCommand = 'ARCHIVE' | 'UNARCHIVE' | 'UPDATE' | 'REMOVE' | 'PURGE'`. Hàm `transition(status, command): { kind: 'OK'; next: ProjectStatus | 'DELETED' } | { kind: 'REJECTED'; code: ErrorCode }` dùng `switch` lồng vét cạn, có kiểm `never`:

| Trạng thái \ Lệnh | ARCHIVE | UNARCHIVE | UPDATE | REMOVE | PURGE |
|---|---|---|---|---|---|
| `ACTIVE` | → `ARCHIVED` | `409 example_project_not_archived` | → `ACTIVE` | → xoá | từ chối (câu 7.4 không bao giờ chọn dòng này) |
| `ARCHIVED` | `409 example_project_not_active` | → `ACTIVE` | `409 example_project_not_active` (sửa đòi `ACTIVE`) | → xoá | → xoá |

- **DB là trọng tài cuối cùng.** Mọi chuyển trạng thái là `UPDATE … WHERE public_id = ? AND status = <trạng thái nguồn> [AND version = ?] RETURNING …`. Có 0 dòng thì đọc lại dòng để phân biệt `404`, `412` và `409` theo bảng trên. Hàm `transition` chỉ để trả lỗi đẹp và cho unit test mọi cặp.
- **Thao tác chuyển trạng thái** đặt `status_changed_at = now()`, `version = version + 1`, `updated_at = now()`.

### 8.2 Quy trình `upstream:sync` (mục 13.4)

Trạng thái suy ra từ git (`MERGE_HEAD`, các path chưa merge), không lưu file trạng thái:

| Trạng thái | Nhận biết | Việc tiếp theo |
|---|---|---|
| `CLEAN` | cây sạch, không `MERGE_HEAD` | kiểm tag → `git merge --no-ff --no-commit <tag>` |
| `MERGING_AUTO` | có `MERGE_HEAD`, còn path chưa merge thuộc vùng tự giải được | tự giải (13.4 bước 4) |
| `MERGING_MANUAL` | có `MERGE_HEAD`, còn path chưa merge thuộc vùng dự án hoặc vùng chung | in danh sách, exit 3. Người sửa xong chạy `--continue` |
| `REGENERATE` | không còn path chưa merge | sinh lại file sinh ra, cập nhật `.upstream/version.json` |
| `VERIFY` | đã sinh lại | `pnpm install --frozen-lockfile`, build, `upstream:check`, test unit |
| `DONE` | verify xanh | in lệnh commit và mở PR (script không tự commit hay push) |

Hàm `nextStep(state)` có `switch` vét cạn. Trạng thái không nhận ra (ví dụ đang rebase) thì exit 1 với thông điệp.

---

## 9. API (feature mẫu)

### 9.1 Route

Mọi route tuân §3 spec cha và SP3 §12: problem+json, `201` + `Location`, `204`, ETag/`If-Match`, merge-patch, phân trang offset. Tên route không mang tiền tố feature. Trùng route với module khác bị kiểm lúc boot (amendment SP3, mục 21).

| Method + path | Quyền | Cổng SP4 | Idempotent | Thành công | Lỗi riêng |
|---|---|---|---|---|---|
| `GET /v1/orgs/{orgId}/projects` | `example_projects.read` | — | — | `200` offset, `?status=ACTIVE\|ARCHIVED`, `?page=&pageSize=` | `422 validation_failed` |
| `POST /v1/orgs/{orgId}/projects` | `example_projects.write` | `requireEnabled('example.projects')` + quota `example.project_count` | `@Idempotent()` | `201` + `Location` + `ETag` | `409 example_project_name_taken`, `422 quota_exceeded` (`errors[0] = { path: 'feature', code: 'example.project_count' }`), `403 feature_not_in_plan` (`errors[0].code = 'example.projects'`) |
| `GET …/projects/{projectId}` | `example_projects.read` | — | — | `200` + `ETag`; `304` khi `If-None-Match` khớp | `404 not_found` |
| `PATCH …/projects/{projectId}` | `example_projects.write` | cờ | — (merge-patch có `If-Match`) | `200` + `ETag` | `428 precondition_required`, `412 precondition_failed`, `409 example_project_not_active`, `409 example_project_name_taken`, `415` khi không phải `application/merge-patch+json` |
| `POST …/projects/{projectId}/archive` | `example_projects.write` | cờ | `@Idempotent()` | `200` + resource | `409 example_project_not_active` |
| `POST …/projects/{projectId}/unarchive` | `example_projects.write` | cờ | `@Idempotent()` | `200` + resource | `409 example_project_not_archived` |
| `DELETE …/projects/{projectId}` | `example_projects.delete` | — (S7-D5) | — | `204` | `404 not_found` |

- **Phân quyền** theo SP3: không phải member, org không tồn tại hay org đã xoá mềm đều cho `404` thống nhất từ middleware; thiếu quyền cho `403 forbidden`. `projectId` là UUID; sai định dạng cho `422 validation_failed`; project của org khác cho `404` (RLS trả 0 dòng).
- **Org API key** (`oak_`) dùng được `read`, `write` (`apiKeyEligible`). Support grant chỉ `read`.
- **PATCH** nhận `{ name?, description? }` (`mergePatchSchema`). Trường lạ → `422`. `status` không sửa được qua PATCH; phải dùng action.
- **`Idempotency-Key`** theo §3.4. Tạo trùng key thì trả lại đúng `201` đã lưu, quota chỉ tiêu một lần (EX-E3).
- Cột "Cổng SP4" ghi "cờ" nghĩa là handler mang `ExampleFeatures.requireEnabled('example.projects')`. `EntitlementRouteInventory` của SP4 (§8.3) kiểm lúc boot rằng các route này là route tenant và key là `FLAG`.

### 9.2 Resource

```jsonc
{ "id": "019dd1a5-…", "name": "Website", "description": null, "status": "ACTIVE",
  "statusChangedAt": "2026-09-28T03:00:00.000Z", "createdAt": "…", "updatedAt": "…" }
```

`ETag` weak lấy từ `version` (`etagOf`). `Location: /v1/orgs/{orgId}/projects/{id}`.

### 9.3 Schema (`http/schemas.ts`)

- `ProjectName = z.string().trim().min(1).max(EXAMPLE_PROJECT_NAME_MAX_LENGTH)`;
- `ProjectDescription = z.string().trim().max(EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH).transform(s => s === '' ? null : s).nullable()`;
- `CreateProjectBody = z.object({ name: ProjectName, description: ProjectDescription.optional().default(null) }).strict()`;
- list query là `offsetPageQuery()` cộng `status`. Response dùng `serialize(ProjectSchema, …)`.

### 9.4 Mã lỗi (`errors.ts`, `defineErrorCodes`)

| Key | Status | code |
|---|---|---|
| `PROJECT_NAME_TAKEN` | 409 | `example_project_name_taken` (map constraint `example_projects_name_uq` bằng `defineConstraintErrors`) |
| `PROJECT_NOT_ACTIVE` | 409 | `example_project_not_active` |
| `PROJECT_NOT_ARCHIVED` | 409 | `example_project_not_archived` |

`not_found`, `precondition_*`, `quota_exceeded`, `feature_not_in_plan` là mã có sẵn của core/SP4, dùng lại. Mã của feature mang tiền tố tên feature (S7-D27); registry mã lỗi đã ném khi trùng.

---

## 10. Async, job, event

### 10.1 Event (`events.ts`)

Ghi qua `EventPublisher.publish` trong `UnitOfWork`. Payload version 1, chỉ id công khai, không tên hay mô tả (nội dung do user nhập có thể là PII). Actor theo SP3 §14: user, `service` với org key, `system` với id `example.projects.purge` cho job xoá.

Mọi `defineEvent` khai **tường minh** `audit` và `webhook` (per R-X3: hai cờ bắt buộc, không mặc định; SP6 6.0 thêm chúng vào `defineEvent`):

| Type | Aggregate | `data` | `audit` | `webhook` |
|---|---|---|---|---|
| `example.project.created` | `example_project` | `{ projectId }` | `true` | `false` |
| `example.project.updated` | `example_project` | `{ projectId, changed: ('name' \| 'description')[] }` | `true` | `false` |
| `example.project.archived` | `example_project` | `{ projectId }` | `true` | `false` |
| `example.project.unarchived` | `example_project` | `{ projectId }` | `true` | `false` |
| `example.project.deleted` | `example_project` | `{ projectId, reason: 'REMOVED' \| 'RETENTION' }` | `true` | `false` |

- `audit: true`: mọi thao tác trên dữ liệu tenant của mẫu để lại dấu vết cho owner khi SP6 audit được cài (payload chỉ có id, nên audit không nhận PII).
- `webhook: false`: event webhook là hợp đồng công khai với khách; mẫu không tự mở hợp đồng đó. Checklist 6.3.3 bước 6 hướng dẫn chọn.

`aggregate.version` bằng `version` sau thay đổi. Với xoá, bằng `version + 1` của dòng cuối cùng: dòng không còn, nên consumer biết event xoá là mới nhất (quy tắc "bỏ event có version cũ hơn" của §6).

Xoá cứng org **không** phát `example.project.deleted` theo từng dòng; `tenancy.org.purged` hàm ý tất cả (như SP3 §14.1). Mẫu không có subscriber; audit SP6 nhận event nhờ `audit: true`. Muốn phản ứng với event, dự án làm theo README "Event".

### 10.2 Queue, job, cron (`jobs.ts`)

Theo quy ước cron S7-D34: phần tỏa ra chạy ở `maintenance`, việc theo org chạy ở queue của feature.

- `ExampleQueue = defineQueue('example', { kind: 'io' })`. Nhóm worker `default` tự consume queue này nhờ `WORKER_QUEUES_EXCLUDE` (S7-D12).
- `PurgeOrgJob = defineJob({ name: 'example.projects.purge-org', queue: ExampleQueue, version: 1, schema: z.object({}).strict() })`. `onInactiveOrg` mặc định `'skip'`: org đã xoá mềm thì cron xoá cứng của tenancy lo.
- **Cron tỏa ra dùng helper quét của core** (SP6 6.0, per R-X4; hợp đồng R-X14, SP6 §5.3). Mẫu chỉ khai báo, không tự viết vòng lặp keyset và không tự gọi hàm definer:

  ```ts
  export const PurgeArchivedSweep = defineOrgSweep({
    key: 'example.projects.purge-archived',
    definerFunction: 'example_orgs_with_purgeable_projects',          // (p_after uuid, p_limit integer, p_retention_sec integer), mục 7.3
    extraParams: () => ({ p_retention_sec: exampleConfig().archivedRetentionSec }),  // EXAMPLE_ARCHIVED_RETENTION_SEC, theo tên
    orgJob: PurgeOrgJob,                                               // meta.orgId = orgId
    jobIdPrefix: 'example-purge',
    schedule: () => ({ cron: exampleConfig().purgeCron, tz: exampleConfig().purgeTz }),       // EXAMPLE_PURGE_CRON/_TZ
    batch: () => ({ size: exampleConfig().purgeOrgBatchSize, maxBatches: exampleConfig().purgeMaxBatches }),
  });
  ```

  - `exampleConfig()` là giá trị trả về của `defineConfig('example', …)` (mục 11.1): factory `registerAs` gọi trực tiếp được và parse env ở mỗi lần gọi (đã đọc `core/config/define-config.ts`); tên thuộc tính theo schema của mẫu. Ba tham số là hàm (không phải giá trị) để định nghĩa lúc import không đọc env; `extraParams` được đọc ở mỗi lượt quét (SP6 §5.3).
  - Helper tự `defineJob` job quét (tên = `key`, queue `maintenance`) và `defineCron`; mẫu khai handler mỏng `@JobHandler(PurgeArchivedSweep.job) class PurgeArchivedSweepHandler { handle() { return this.runner.run(PurgeArchivedSweep) } }` ở `forWorker()` (luật "một handler một job" của `WorkerHost`).
  - Runner gọi `public.example_orgs_with_purgeable_projects(p_after => $1::uuid, p_limit => $2::integer, p_retention_sec => $3::integer)` trên pool `app_user`, con trỏ keyset, dừng khi lô ngắn hơn `size`.
  - `jobId` = `example-purge-<orgId>-<slot>` theo luật slot duy nhất của helper (`slot = floor(epochSec / slotSec)`, `slotSec` = khoảng cách nhỏ nhất giữa hai lượt của cron; SP6 §5.3), không `:`, hợp lệ theo `assertEnqueueOpts`;
  - cảnh báo tồn đọng (chạm `maxBatches` mà lô cuối vẫn đầy) do helper log (`org_sweep_backlog`).
  - r1 giả định helper nhận callback `(cursor, limit) → orgId[]` qua `SqlPurgeCandidates`; SP6 không có dạng đó (R-X14), nên r2 bỏ `SqlPurgeCandidates` và đổi chữ ký hàm definer (mục 7.3). O-1 đóng phần helper.
- **`PurgeOrgHandler`** (trong `OrgScope` do `WorkerHost` bọc): một `UnitOfWork` chạy câu 7.4 với `EXAMPLE_PURGE_ROWS_PER_JOB`, rồi `releaseAllocation`, phát event, đếm `example_projects_purged_total`. Idempotent: chạy lại chỉ xoá dòng còn đến hạn.
- **Hệ quả của `jobId` theo slot:** mỗi lượt cron (slot mới) tạo job mới cho org còn dòng đến hạn, kể cả khi job của lượt trước đã `failed` và còn được giữ (tới `QUEUE_KEEP_FAILED_AGE_SEC`, mặc định 7 ngày). Vì vậy một org có job lỗi chỉ trễ tới lượt cron sau, không phải tới khi BullMQ dọn job lỗi (r0 dùng `jobId` cố định nên trễ tới 7 ngày, I6). Hai job của hai lượt chồng nhau vẫn tách rời nhờ `SKIP LOCKED` (R7-9).

### 10.3 Participant xoá cứng org

`@OrgPurgeParticipantContributor({ key: 'example.projects', order: 200 })` trên provider `ExampleProjectsPurgeParticipant implements OrgPurgeParticipant`:
- `purge(orgId)`: `DELETE FROM example_projects WHERE org_id = ?`, chạy trong transaction purge của tenancy.
- Không `release` quota: bộ đếm của org bị participant của SP4 (order 100) xoá trong cùng transaction.
- Không event (10.1).
- **`order` = 200** theo registry order ở addendum 3D §A4 (per R-X5, R-X12: `core.scheduled-tasks` 0, entitlements 100, files 110, integrations 120, mẫu 200, tenancy core 1000 cuối cùng và không phải participant). Không có FK giữa `example_projects` và bảng của SP4/SP6, nên thứ tự tương đối với chúng không ảnh hưởng đúng/sai; điều kiện duy nhất là chạy trước tenancy core (1000), nơi xoá `organizations`. Thiếu participant thì FK `RESTRICT` làm purge fail to (`23001`), không để dòng mồ côi (EX-I6).

### 10.4 API SP4 mà mẫu dùng (SP4 §6.4, §8, §9, §12.3)

Mẫu dùng đúng API công khai của SP4 r0/r1, không lớp trung gian nào. Plan 7D đối chiếu lại với SP4 r1 đã duyệt ở bước đầu; tên nào khác thì theo SP4 (O-1).

| Việc | API SP4 | Chỗ dùng trong mẫu |
|---|---|---|
| Khai báo tính năng | `defineFeatureCatalogue({...})` + provider `@FeatureCatalogueContributor(ExampleFeatures)` ở `forApi()` và `forWorker()`; dòng `entitlement_features` cùng migration (7.2) | `entitlements.ts` |
| Cổng route | `ExampleFeatures.requireEnabled('example.projects')` = `SetMetadata` + `UseInterceptors(EntitlementInterceptor)`; chạy sau mọi guard, trong `OrgScope` của `OrgScopeInterceptor` (S4-D7); tắt → `403 feature_not_in_plan` | `POST`/`PATCH`/archive/unarchive (9.1) |
| Tiêu quota | `Quotas.consumeOrThrow('example.project_count', 1): Promise<QuotaReceipt>`; đòi `UnitOfWork` đang mở và org context; hết → `422 quota_exceeded` và transaction của caller rollback | `ProjectService.create` (sau `INSERT`, S7-D35) |
| Trả quota | `Quotas.releaseAllocation('example.project_count', n)` (chỉ `QUOTA` kỳ `NONE`); trả quá `used` → `QuotaReleaseUnderflowError` (500) | xoá tay, `PurgeOrgHandler` (sau `DELETE … RETURNING`) |
| Dọn khi purge org | participant purge của SP4 (order 100) xoá `usage_counters` và override của org | không có code trong mẫu |
| Dòng gói của org | participant tạo org của SP4 (`entitlements.provision`) | không có code trong mẫu |

- Key được truyền qua helper có kiểu của catalogue (`ExampleFeatures.key('example.project_count')`, SP4 §6.4) để gõ sai là lỗi compile.
- **Bảo đảm mà mẫu dựa vào** (SP4 đã viết; 7D kiểm lại bằng EX-E7, EX-E8, EX-I10, EX-I11):
  1. consume là **một** câu `INSERT … ON CONFLICT (org_id, feature_id, period_start) DO UPDATE … WHERE used + n <= limit` trong transaction của caller (SP4 §9.2); hai consume song song tuần tự hoá trên khoá dòng bộ đếm;
  2. release không bao giờ làm `used < 0` (SP4 §9.3);
  3. `fallback: UNLIMITED` vẫn ghi bộ đếm (câu consume chỉ bỏ `WHERE`), nên bất biến "bộ đếm = số dòng" đúng cả khi không giới hạn;
  4. hạ gói xuống dưới mức đang dùng không xoá dữ liệu; chỉ chặn consume tiếp (`OVER_LIMIT`, SP4 §9.4).
- **Plan catalogue cho test:** test của mẫu dựng composition với catalogue gói fixture (`plans` của `composeAppModules`, X-7) có gói `limited` đặt `example.project_count: { max: N }` và gói `no-projects` đặt `example.projects: false`; gán gói cho org test bằng đúng cách test của SP4 dùng (hỗ trợ seed của SP4), không ghi thẳng bảng của SP4.

### 10.5 Mã hoá lại (S7-D21, S7-D22)

- **Port** `EncryptedFieldSet` (core/security):
  - `countByKey(): Promise<ReadonlyMap<string, number>>` (khoá của keyring → số giá trị; một dòng có nhiều cột được đếm theo từng cột; giá trị không đọc được khoá thì đếm dưới khoá `'unknown'`);
  - `reencryptBatch(limit: number): Promise<{ scanned: number; rewritten: number; skipped: number; undecryptable: number }>` (chỉ với `mode: 'REWRITE'`).
- **Tập đăng ký** bằng marker `@EncryptedFieldSetContributor({ key, keyring, mode })` trên provider của **worker**.
- **Cron** `core.security.reencrypt` (`SECURITY_REENCRYPT_CRON`, `_TZ`, `_BATCH_SIZE`, `_MAX_BATCHES`), queue `maintenance`. Với mỗi tập:
  1. `countByKey()`, rồi ghi gauge `encrypted_rows{set, keyring, key}`. Nhãn có số giá trị nhỏ: số kid cộng `unknown`, không có org.
  2. Nếu `mode = 'REWRITE'`, keyring có **hơn một** khoá, và `countByKey()` thấy khoá khác khoá active (trừ `unknown`, vốn không giải mã được): gọi `reencryptBatch` tối đa `_MAX_BATCHES` lần. Keyring một kid thì bỏ bước này: không có gì để ghi lại, và câu chọn dòng `split_part(…) <> $activeKid` không có index nên là quét toàn bảng vô ích (M6).
  - Chi phí: `countByKey` vẫn quét mọi bảng đã đăng ký mỗi lượt (gồm `email_deliveries` giữ tới `NOTIFICATIONS_RETENTION_DAYS`), nên lịch mặc định là mỗi giờ. Plan 7C đo `EXPLAIN (ANALYZE, BUFFERS)` của câu đếm trên seed cỡ 10× và ghi vào plan; chậm hơn ngân sách thì hạ tần suất hoặc đổi sang đếm theo lô keyset.
- **Mỗi giá trị được xử lý như sau:**
  1. Đọc `id` cộng giá trị cũ.
  2. Giải mã bằng keyring (FieldCipher: AAD như lúc ghi; Better Auth: `symmetricDecrypt` với `secretConfig`).
  3. Mã hoá bằng khoá active.
  4. `UPDATE … SET col = $new WHERE id = $id AND col = $old` (compare-and-swap, race R7-10), autocommit từng dòng, không giữ transaction dài.
  - Không giải mã được → `undecryptable++`, log ERROR `{ event: 'reencrypt_undecryptable', set, id }` (chỉ id nội bộ, không giá trị), bỏ qua dòng. Không bao giờ ghi đè.
- **Chọn dòng cần xử lý bằng SQL:**
  - FieldCipher: `split_part(col, '.', 2) <> $activeKid` trên định dạng `v1.<kid>.…`.
  - Better Auth: parse envelope ở app, sau khi đọc theo lô keyset `id > cursor`.
- **Pool:** `auth.account` và `auth.two_factor`/`auth.jwks` qua pool `auth_user` (worker đã có); `email_deliveries` chỉ đếm, qua pool app.
- **Tập đăng ký:**

  | key | keyring | mode | Cột |
  |---|---|---|---|
  | `identity.account-tokens` | field | REWRITE | `auth.account.access_token`, `refresh_token`, `id_token` |
  | `notifications.email-deliveries` | field | EXPIRE | `email_deliveries.recipient_enc`, `params_enc` |
  | `identity.better-auth-secrets` (sau T7-1) | auth | REWRITE | `auth.two_factor.secret`, `.backup_codes`, `auth.jwks.private_key` |

---

## 11. Config

### 11.1 `example.config.ts` (namespace `example`)

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `EXAMPLE_ARCHIVED_RETENTION_SEC` | `2592000` (30 ngày) | 3600–31536000 |
| `EXAMPLE_PURGE_CRON` | `30 3 * * *` | `isValidCron` |
| `EXAMPLE_PURGE_TZ` | `UTC` | `normalizeTimezone` |
| `EXAMPLE_PURGE_ORG_BATCH_SIZE` | `100` | 1–`DEFINER_LIMIT_MAX` (hằng của core) |
| `EXAMPLE_PURGE_MAX_BATCHES` | `10` | 1–1000 |
| `EXAMPLE_PURGE_ROWS_PER_JOB` | `1000` | 1–10000 |

- Mặc định chạy được với env hiện có (nguyên tắc INT-I12 của SP3). Giới hạn quota nằm trong gói của SP4, không trong env.
- Cặp `EXAMPLE_PURGE_CRON`/`_TZ` theo quy ước "mỗi cron một cặp `<X>_CRON` + `<X>_TZ`" của mọi cron hiện có (`OUTBOX_CLEANUP_TZ`, `TENANCY_ORG_PURGE_CRON/_TZ`…). Helper của SP6 nhận lịch, lô và tham số thêm qua hàm (`schedule`, `batch`, `extraParams`), không quy định tên env, nên bốn env của mẫu giữ nguyên tên (r2 đóng câu điều kiện của r1).
- Không trường nào là secret.

### 11.2 Core, identity

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `WORKER_QUEUES_EXCLUDE` | trống | danh sách; loại trừ với `WORKER_QUEUES` (6.5) |
| `SECURITY_REENCRYPT_CRON` | `17 * * * *` (mỗi giờ, phút lệch để không trùng cron đầu giờ khác) | cron hợp lệ |
| `SECURITY_REENCRYPT_TZ` | `UTC` | IANA |
| `SECURITY_REENCRYPT_BATCH_SIZE` | `200` | 1–1000 |
| `SECURITY_REENCRYPT_MAX_BATCHES` | `10` | 1–1000 |
| `AUTH_SECRETS` (sau T7-1) | trống | JSON `{"<version>":"<secret>"}`, version là số nguyên ≥ 0, mỗi secret ≥ 32 ký tự (luật entropy như `BETTER_AUTH_SECRET`). **secret** (redact) |
| `AUTH_SECRET_CURRENT_VERSION` | trống | bắt buộc khi có `AUTH_SECRETS`, phải là một khoá của nó |

- `BETTER_AUTH_SECRET` thành "bắt buộc ở `local`/`hybrid` **trừ khi** có `AUTH_SECRETS`". Khi cả hai cùng có, nó là secret legacy (giải mã bản bare-hex cũ).
- `AUTH_SECRETS` được thêm vào danh sách redact gốc (§12) và mang `.meta({ secret: { roles: ['api', 'worker'] } })`, nên tự vào allowlist của chart sau `pnpm chart:secrets` (12.5).

### 11.3 Khoá không bí mật theo vai trò

Sau các sửa C2 (mục 6.5), mọi khoá **không** bí mật dùng chung được qua `config` (ConfigMap chung), kể cả `SMTP_USER`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_OIDC_*` không bí mật. Một số khoá **phải** khác nhau theo vai trò và do chart tự đặt, không đặt trong `config`:

| Khoá | Ai đặt | Giá trị |
|---|---|---|
| `APP_ROLE` | chart, mỗi container | `api` / `worker` / `migrate` |
| `HTTP_HOST`, `HTTP_PORT` | chart, api | `0.0.0.0`, `3000` |
| `WORKER_HEALTH_HOST`, `WORKER_HEALTH_PORT` | chart, worker | `0.0.0.0`, `3001` |
| `WORKER_QUEUES`, `WORKER_QUEUES_EXCLUDE`, `OUTBOX_AUTOSTART` | chart, từng nhóm worker | từ `workers.<g>` |
| `QUEUE_DASHBOARD_*` | chart, nhóm có `dashboard: true` | 12.2 |
| `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES` | chart, api và worker (không migrate) | 12.2 |

Schema cấm các khoá trên trong `config` (chart là nguồn duy nhất). Dự án cần giá trị khác theo vai trò cho khoá khác (ví dụ `RESILIENCE_ALLOWED_PORTS` riêng cho worker) thì đặt ở `api.env` hoặc `workers.<g>.env`; hai map này đè `config` và chịu cùng luật cấm tên secret.

---

## 12. Helm chart chi tiết

### 12.1 Values (rút gọn; `values.schema.json` ép kiểu, `required`, `additionalProperties: false`)

```yaml
image: { repository: "", digest: "", tag: "", pullPolicy: IfNotPresent }  # schema: repository bắt buộc; digest hoặc tag bắt buộc
imagePullSecrets: []
environment: ""                    # bắt buộc; vào OTEL_RESOURCE_ATTRIBUTES deployment.environment.name
config: {}                         # env không bí mật chung (ConfigMap); schema cấm tên secret sinh từ code và khoá do chart đặt (11.3, 12.5)
secretEnv: {}                      # ENV: { secretName, key, roles: [api|worker|migrate] }; ENV và roles phải nằm trong files/secret-env.json
secretEnvExtra: {}                 # secret của feature dự án: ENV: { secretName, key, roles }; không trùng tên boilerplate, không trùng khoá config
extraCaCerts: { configMapName: "", key: "ca.crt" }   # mount + NODE_EXTRA_CA_CERTS (TLS Redis/SMTP nội bộ)
dbCa: { configMapName: "", key: "ca.crt" }           # mount + DB_SSL_CA_PATH
otel: { enabled: false, endpoint: "", endpointFromHostIP: { enabled: false, port: 4318, scheme: http }, serviceNamePrefix: "" }
serviceAccount: { create: true, name: "", annotations: {} }
podSecurity: { runAsUser: 65532, runAsGroup: 65532 }
terminationGracePeriodSeconds: 30
topologySpread: { hostname: ScheduleAnyway, zone: ScheduleAnyway }
api:
  replicas: 2
  env: {}
  resources: { requests: { cpu: 500m, memory: 512Mi }, limits: { memory: 512Mi } }
  hpa: { enabled: true, minReplicas: 2, maxReplicas: 6, targetCPUUtilizationPercentage: 70, extraMetrics: [] }
  pdb: { maxUnavailable: 1 }
  service: { type: ClusterIP, port: 80 }
  probes: { startup: { periodSeconds: 2, failureThreshold: 30 }, liveness: { periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 }, readiness: { periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 2 } }
workers:
  scheduler:
    queues: [maintenance]
    queuesExclude: []
    relay: true
    dashboard: true
    replicas: 2
    env: {}
    hpa: { enabled: false }
    resources: { requests: { cpu: 100m, memory: 384Mi }, limits: { memory: 384Mi } }
  default:
    queues: []
    queuesExclude: [maintenance]
    relay: false
    dashboard: false
    env: {}
    hpa: { enabled: true, minReplicas: 2, maxReplicas: 6, targetCPUUtilizationPercentage: 70, extraMetrics: [] }
    resources: { requests: { cpu: 250m, memory: 512Mi }, limits: { memory: 512Mi } }
dashboard: { ipAllowlist: "127.0.0.1/32", ingressFrom: [] }
migrate:
  enabled: true
  args: [up]
  nameSuffix: ""
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 604800  # review plan 7B, I1: Job tên theo revision, TTL dọn Job đã xong
  resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 256Mi } }
httpRoute: { enabled: false, parentRefs: [], hostnames: [], requestTimeout: 30s }
ingress: { enabled: false, className: "", hosts: [], tls: [] }
networkPolicy:
  enabled: true
  apiIngressFrom: []               # bắt buộc (không rỗng) khi enabled
  egress:                          # mỗi nhóm: danh sách peer (podSelector/namespaceSelector/ipBlock) + ports; rỗng = không có rule
    dns: {…}
    postgres: []                   # worker (relay), migrate
    pgbouncer: []                  # api, worker
    redis: []                      # api, worker
    smtp: { rules: [], internet: { ports: [] } }   # worker; internet.ports: SMTP ra ngoài, không qua RESILIENCE_ALLOWED_PORTS (review plan 7B, I5)
    otel: []                       # api, worker
    objectStorage: []              # api, worker (S3/MinIO trong cụm hoặc VPC endpoint, SP6)
    clamd: []                      # worker (FILES_CLAMD_HOST, SP6)
    idp: []                        # api; nhóm worker có dashboard khi AUTH_MODE=external (JWKS)
    internet: { enabled: true, exceptExtra: [] }    # cổng = RESILIENCE_ALLOWED_PORTS của vai trò (bắt buộc đặt tường minh)
    extra: { api: [], worker: [], migrate: [] }   # NetworkPolicyEgressRule thô cho đường riêng của dự án
connectionBudget: { pgbouncerClients: 0, postgresDirect: 0 }   # 0 = tắt kiểm
dbPoolGuard: { enabled: true, queues: [webhooks-out], headroom: 2 }   # review plan 7B, HC-31
```

- **Tên đối tượng:** `<release>-saas-app-api`, `…-worker-<group>`, `…-migrate<suffix>`. Nhãn chuẩn `app.kubernetes.io/{name,instance,version,component,part-of,managed-by}`; `component` là `api`, `worker-<group>` hoặc `migrate`.
- **Tên nhóm worker** khớp `^[a-z][a-z0-9-]{0,20}$`. Schema kiểm; thêm một kiểm trong template cho độ dài tên đối tượng ≤ 63.
- **Độ phủ queue** (kiểm tĩnh trong `_helpers.tpl`, `fail` với thông điệp nêu tên queue và nhóm, HC-25). Gọi nhóm có `queues: []` là nhóm **bắt-tất-cả**:
  1. phải có ít nhất một nhóm bắt-tất-cả, để queue mới của dự án luôn có consumer (S7-D12);
  2. mỗi tên trong `queuesExclude` của một nhóm phải được consume bởi nhóm khác (có trong `queues` của nhóm đó, hoặc nhóm đó bắt-tất-cả mà không loại trừ nó). Đây là lỗi values duy nhất làm một queue mồ côi mà template phát hiện được;
  3. một queue có trong `queues` tường minh của một nhóm thì không được nhóm khác consume (tường minh ở nhóm khác, hoặc nhóm bắt-tất-cả không loại trừ nó). Tách queue nóng sang nhóm riêng vì vậy **bắt buộc** thêm nó vào `queuesExclude` của `default`, nếu không bulkhead không có thật.
  - Tên queue lạ (không đăng ký trong app) vẫn chỉ phát hiện lúc boot (`WORKER_QUEUES contains unknown queue`), vì chart không biết queue của dự án.

### 12.2 Pod và container (mọi vai trò)

Theo §13.3 và PSA `restricted`:
- **Pod:** `securityContext { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: RuntimeDefault } }`; `automountServiceAccountToken: false`; `enableServiceLinks: false` (S7-D32).
- **Container:** `securityContext { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, privileged: false, capabilities: { drop: [ALL] } }`.
- **Volume:** `emptyDir` `/tmp` (`sizeLimit: 64Mi`, cấu hình được). CA mount read-only nếu có.
- **Lệnh:** image có ENTRYPOINT `node`, chart chỉ đặt `args`:
  - api: `[--import, ./dist/instrumentation.js, dist/main.api.js]`;
  - worker: `[--import, ./dist/instrumentation.js, dist/main.worker.js]`;
  - migrate: `[dist/main.migrate.js, <migrate.args…>]`. Không `--import instrumentation`, nên Job migrate **không** phát telemetry (có chủ đích: process ngắn, log là nguồn chẩn đoán; chart không đặt `OTEL_*` cho Job).
- **Env theo vai trò** (sau ConfigMap chung, nên đè được):
  - `APP_ROLE` (S7-D32);
  - api: `HTTP_HOST=0.0.0.0`, `HTTP_PORT=3000`;
  - worker: `WORKER_HEALTH_HOST=0.0.0.0`, `WORKER_HEALTH_PORT=3001`, `WORKER_QUEUES`/`WORKER_QUEUES_EXCLUDE` (nối bằng `,`), `OUTBOX_AUTOSTART`;
  - nhóm có dashboard: `QUEUE_DASHBOARD_ENABLED=true`, `QUEUE_DASHBOARD_HOST=0.0.0.0`, `QUEUE_DASHBOARD_PORT=3002`, `QUEUE_DASHBOARD_IP_ALLOWLIST` = `dashboard.ipAllowlist` (mặc định `127.0.0.1/32`: truy cập qua `kubectl port-forward`, kết nối tới từ loopback trong network namespace của pod).
- **Downward API** (khi `otel.enabled`; chart đặt `OTEL_ENABLED=true` vì `otelConfig` mặc định `false`): `POD_NAME`, `POD_NAMESPACE`, `POD_UID`, `HOST_IP`, rồi:
  - `OTEL_RESOURCE_ATTRIBUTES=k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),k8s.pod.uid=$(POD_UID),deployment.environment.name=<environment>,app.role=<role>[,app.worker.group=<g>]` (T7-4);
  - `OTEL_SERVICE_NAME=<prefix>-<role>`;
  - `OTEL_EXPORTER_OTLP_ENDPOINT` = `otel.endpoint`, hoặc `<scheme>://$(HOST_IP):<port>` khi `endpointFromHostIP.enabled`.
  - Thứ tự khai báo env bảo đảm `$(VAR)` đã có trước khi được dùng.
- **Probe:**

  | | api (port `http` 3000) | worker (port `health` 3001) |
  |---|---|---|
  | startup | `/health/live` | như api |
  | liveness | `/health/live` | như api |
  | readiness | `/health/ready` | như api |

  Mặc định lấy từ 12.1. `timeoutSeconds: 1` lớn hơn `HEALTH_CHECK_TIMEOUT_MS` (500), nên probe nhận `503` sạch.
- **Tắt êm:** `terminationGracePeriodSeconds` (30) phải lớn hơn `APP_SHUTDOWN_TIMEOUT_MS` (28000). Template `fail` khi `config.APP_SHUTDOWN_TIMEOUT_MS` (nếu đặt) ≥ grace × 1000. Không `preStop`: api tự trả readiness `503` trong `HEALTH_DRAIN_DELAY_MS` rồi mới đóng (`ShutdownCoordinator`).
- **Rollout:** `strategy.rollingUpdate { maxSurge: 25%, maxUnavailable: 0 }`, `revisionHistoryLimit: 5`, `progressDeadlineSeconds: 300`.
- **Annotation checksum:** `checksum/config` = sha256 của ConfigMap đã render, nên đổi config thì pod lăn. Secret đổi ở nguồn ngoài **không** làm pod lăn; runbook xoay khoá có bước `kubectl rollout restart`.
- **Trải pod:** `topologySpreadConstraints` theo `kubernetes.io/hostname` và `topology.kubernetes.io/zone`, `maxSkew: 1`, `whenUnsatisfiable` từ values, `matchLabelKeys: [pod-template-hash]`. Đây là anti-affinity mềm của §9.

### 12.3 HPA, PDB, Service

- **HPA** `autoscaling/v2` khi `hpa.enabled`: Deployment bỏ `replicas`, để HPA sở hữu. Metric CPU cộng `extraMetrics` (dán nguyên khối `metrics` của HPA v2; schema kiểm `type` ∈ `Resource|Pods|External|Object`). `behavior.scaleDown.stabilizationWindowSeconds: 300`. Nhóm `scheduler` không có HPA.
- **Bật/tắt HPA trên release đang chạy** (M8): khi bật, bản render mới không còn `replicas`; cả client-side lẫn server-side apply (Helm 4 cài mới mặc định `--server-side auto`) đều đưa Deployment về 1 replica cho tới khi HPA phản ứng. Runbook deploy (14.1) có mục riêng: làm trong cửa sổ ít tải; ngay sau `helm upgrade`, `kubectl scale deploy/<tên> --replicas=<minReplicas>` để khỏi chờ HPA; theo dõi `kubectl get hpa`. Khi tắt HPA, `replicas` trở lại từ values ở cùng lần upgrade, không có khoảng hụt.
- **PDB** `policy/v1` `maxUnavailable: 1` và `unhealthyPodEvictionPolicy: AlwaysAllow` cho mỗi Deployment (review plan 7B, I3: pod đang `CrashLoopBackOff`/chưa Ready không được chặn drain node). Luôn render: với 1 replica vẫn cho evict, không chặn drain node.
- **Service:**
  - api: `ClusterIP` port 80 → `http`;
  - dashboard: `ClusterIP` port 3002, chỉ để port-forward/nội bộ; không bao giờ ra qua HTTPRoute/Ingress (schema không cho khai).
- **Dashboard mở trong cụm** (M9): `dashboard.ingressFrom` khác rỗng mà `dashboard.ipAllowlist` vẫn là `127.0.0.1/32` → `fail` ("mọi request trong cụm sẽ nhận 403; đặt ipAllowlist khớp nguồn của ingressFrom"). App kiểm IP theo `QUEUE_DASHBOARD_IP_ALLOWLIST`, NetworkPolicy chỉ mở đường; hai lớp phải khớp nhau (HC-28).

### 12.4 Job migrate (hook)

- **Annotation:** `helm.sh/hook: pre-install,pre-upgrade`, `helm.sh/hook-weight: "0"`, `helm.sh/hook-delete-policy: before-hook-creation`, `helm.sh/hook-output-log-policy: hook-failed` (Helm 4.3 in log của Job lỗi ngay trong output của `helm upgrade`; Helm 3.22 bỏ qua annotation lạ).
- **Tên Job theo revision** (review plan 7B, I1): `<fullname>-migrate<nameSuffix>-r<.Release.Revision>`. Với tên cố định, `before-hook-creation` của một lần `helm upgrade` chạy lại sau timeout sẽ **xoá Job đang chạy**, giết migration giữa chừng (có thể để lại index `INVALID` của `CONCURRENTLY`). Tên theo revision làm Job cũ không bị đụng; `ttlSecondsAfterFinished` (`migrate.ttlSecondsAfterFinished`, mặc định 7 ngày) dọn Job đã xong. Hai Job cùng chạy thì khoá advisory (R7-12) cho một bên exit 1 có tên. Runbook 14.1/14.3: trước khi chạy lại `helm upgrade`, `kubectl get job -l app.kubernetes.io/component=migrate` không còn Job `active` và `pg_stat_activity` không còn phiên `application_name = 'saas-migrator-lock'` (R7-19). Kind smoke HC-K10 kiểm hành vi thật của Helm 4.3.
- **Khe tạo lại NetworkPolicy hook:** `before-hook-creation` xoá rồi tạo lại NetworkPolicy của Job ở mỗi lần upgrade; Job đang chạy từ revision trước có thể mất egress trong khe đó (namespace default-deny). Đây là thêm một lý do của điều kiện "không Job `active`" trước khi chạy lại.
- **PID 1 và SIGTERM** (review plan 7B, m2): container chạy `node` trực tiếp làm PID 1 (ENTRYPOINT distroless, không shell, không init). App tự cài handler SIGTERM (`installShutdown`); migrator không cài, nên SIGTERM của kubelet chỉ có tác dụng khi grace hết (SIGKILL) — đúng là lý do `terminationGracePeriodSeconds = G`. Template ghi giả định này trong chú thích; ADR 0021 ghi lại.
- **Nhãn pod của Job:** `app.kubernetes.io/component: migrate` cố định, **không** phụ thuộc `migrate.nameSuffix`, để Job chạy tay (`-down-<ticket>`) vẫn khớp `podSelector` của NetworkPolicy hook (HC-9).
- **Spec Job:** `backoffLimit: 0`, `activeDeadlineSeconds: migrate.activeDeadlineSeconds`, `restartPolicy: Never`, `serviceAccountName: default` (không cần danh tính cloud; tránh phụ thuộc ServiceAccount chưa tồn tại lúc cài lần đầu).
- **`terminationGracePeriodSeconds`** = `G = ceil(config.DB_MIGRATION_STATEMENT_TIMEOUT_MS / 1000)`: runner không có handler SIGTERM, cho câu `CREATE INDEX CONCURRENTLY` chạy xong như compose (`stop_grace_period: 10m`). `migrate.enabled` mà `config.DB_MIGRATION_STATEMENT_TIMEOUT_MS` không đặt → `fail` (chart không chép mặc định 600000 của app, nên hai bên không lệch được).
- **Ngân sách thời gian** (M2). Sau `activeDeadlineSeconds` (`D`), pod bị dừng và có tới `G` giây để thoát; trên Kubernetes gần đây, điều kiện kết thúc của Job có thể chờ pod dừng hẳn. Vì vậy thời gian xấu nhất Helm phải chờ Job là `D + G`:
  - template `fail` khi `D ≤ G` (một câu hợp lệ dài nhất phải vừa trong hạn);
  - `NOTES.txt` in giá trị tối thiểu `T_min = D + G + 60` giây (60 s là lề cho lập lịch pod và kéo image; mặc định `900 + 600 + 60 = 1560` giây = 26 phút) và lệnh deploy đầy đủ với `--timeout ${T_min}s`. Helm 4.3 áp `--timeout` cho **từng** thao tác, nên `T_min` là ngân sách của riêng hook, không phải của cả lần upgrade.
- **Env nhúng thẳng** (S7-D15):
  - các khoá của `config` có tiền tố `APP_`, `LOG_`, `DB_`, cộng `NODE_ENV`, trừ mọi khoá secret (danh sách sinh ra);
  - `APP_ROLE=migrate`;
  - các secret mà `files/secret-env.json` cho vai trò `migrate` (hôm nay chỉ `DB_OWNER_PASSWORD`) qua `secretKeyRef`.
  - Test CO-3 chứng minh migrate khởi động với **đúng** tập này, với `NODE_ENV=production` (luật `database-query-deadline` bỏ qua vai trò migrate, mục 6.5).
- **NetworkPolicy của Job** là hook `pre-install,pre-upgrade` weight `-10`, `before-hook-creation`, `podSelector` theo `component: migrate`. Chỉ cho egress DNS, `networkPolicy.egress.postgres` (migrate đi thẳng Postgres, Ruling R8) và `extra.migrate`. Không có ingress. Hook này còn lại sau upgrade (chính sách xoá `before-hook-creation`), nên Job chạy tay bằng `kubectl apply` cũng được phủ.
- **Chạy tay:** `migrate.args` và `migrate.nameSuffix` cho phép render Job `down <target>` hoặc `status` bằng `helm template --show-only templates/migrate-job.yaml` rồi `kubectl apply` (runbook 14.3). Lệnh render phải dùng **cùng** `-f deploy/values/<env>.yaml` và `--set image.digest=<digest đang deploy>` như release hiện tại: code của `down` nằm trong image mới, và thiếu values thì schema fail. Annotation hook vô hại khi apply bằng kubectl.

### 12.5 Config và secret

- **ConfigMap** `<fullname>-config` = `config` (chuỗi). **Schema:** `config`, `api.env` và `workers.*.env` có `propertyNames: { not: { anyOf: [ { $ref: '#/$defs/secretEnvName' }, { $ref: '#/$defs/chartOwnedEnvName' } ] } }`. `secretEnvName.enum` **sinh từ code** (S7-D33); `chartOwnedEnvName.enum` là các khoá chart tự đặt (11.3). Không còn regex tên: tham số như `AUTH_PASSWORD_MIN_LENGTH`, `AUTH_EMAIL_TOKEN_TTL_SEC`, `AUTH_EXTERNAL_TOKEN_COOKIE` đặt được qua `config`.
- **Allowlist secret theo vai trò** = `files/secret-env.json` (sinh từ metadata `secret.roles`, không sửa tay; `pnpm chart:secrets --check` trong CI). Nội dung ở thời điểm 7B, suy từ code sau các sửa C2 (mục 6.5):

  | ENV | api | worker | migrate | Luật đòi ở vai trò |
  |---|---|---|---|---|
  | `DB_APP_PASSWORD` | ✓ | ✓ | | `database-app-password-required` (api, worker) |
  | `DB_AUTH_PASSWORD` | ✓ | ✓ | | luật `authDatabase` hiện có (`role !== 'migrate'`, trừ `external`) |
  | `DB_RELAY_PASSWORD` | | ✓ | | kiểm ở chỗ dùng (`database.module.ts`, pool relay chỉ ở worker) |
  | `DB_OWNER_PASSWORD` | | | ✓ | kiểm ở chỗ dùng (`migrator.ts`) |
  | `REDIS_URL` | ✓ | ✓ | | schema `redis` (migrate không nạp namespace này) |
  | `FIELD_ENCRYPTION_KEYS` | ✓ | ✓ | | schema `security` (migrate không nạp) |
  | `BETTER_AUTH_SECRET`, `AUTH_SECRETS` | ✓ | ✓ | | `identity` (`local`/`hybrid`) |
  | `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_OIDC_CLIENT_SECRET` | ✓ | | | luật cặp Google / `hybrid` chỉ ở api (C2) |
  | `SMTP_PASSWORD` | | ✓ | | `smtp-auth-pair` chỉ ở worker (C2) |

  - `secretEnv` khai một khoá không có trong file, hoặc với vai trò ngoài `roles` của nó → template `fail`.
  - Module sau **không** sửa chart: SP5/SP6 đánh dấu `.meta({ secret: { roles } })` trên trường của mình và làm luật đòi nó biết vai trò (amendment D2), rồi `pnpm chart:secrets` sinh lại file (CI bắt nếu quên).
  - Feature của dự án thêm secret bằng `secretEnvExtra` (khai rõ vai trò). Chart `fail` khi tên trùng một tên trong `files/secret-env.json` hoặc trùng một khoá của `config`/`api.env`/`workers.*.env` (secret của dự án không thể đồng thời nằm trong ConfigMap).
  - Test CO-4 là bằng chứng rằng file sinh ra và luật config khớp nhau: mỗi vai trò validate xanh với **chỉ** các secret mà file cho nó.
- **Kiểm budget connection** (khi khác 0; review plan 7B, I4: trong rolling update có thêm `maxSurge` pod cùng chạy):
  - gọi `peak(role) = maxReplicas(role) + ceil(maxSurge × maxReplicas(role))` (`rollout.maxSurge` là phần trăm hoặc số nguyên);
  - PgBouncer: `Σ peak(role) × (DB_POOL_MAX + DB_AUTH_POOL_MAX)` trên api và mọi nhóm worker phải ≤ `pgbouncerClients`;
  - Postgres trực tiếp: `Σ peak(worker) × DB_RELAY_POOL_MAX + 2` phải ≤ `postgresDirect`; phần `2` của migrate = 1 phiên khoá advisory + `MIGRATION_ORM_POOL_MAX` (= 1, đặt tường minh trong `migrator.ts`; chart giữ hằng có tên và một test so hai số).
  - Đọc giá trị từ `config`; thiếu thì `fail` với thông điệp "set DB_POOL_MAX/… explicitly when connectionBudget is on" (§10: tổng connection tính theo replica tối đa của HPA).
- **Pool của nhóm worker ↔ concurrency** (review plan 7B; README 6C "Pool DB", R-X35; HC-31): `dbPoolGuard: { enabled: true, queues: [webhooks-out], headroom: 2 }`. Mọi nhóm worker consume một queue trong `queues` phải đặt tường minh `DB_POOL_MAX` và concurrency của queue đó (`QUEUE_CONCURRENCY_OVERRIDES` mục `<q>=<n>`, parse như app: tách `,`, `trim`, đúng hai phần quanh `=`; không có thì `QUEUE_IO_CONCURRENCY`), và `DB_POOL_MAX ≥ Σ n + headroom`; `enabled: false` khi tắt `integrations`.
- **Header OTLP** (review plan 7B, M8): `OTEL_EXPORTER_OTLP_HEADERS` (thường chứa token của collector) bị cấm trong `config`/`api.env`/`workers.*.env` (thuộc `chartOwnedEnvName`); dự án cần nó thì khai qua `secretEnvExtra`.

### 12.6 NetworkPolicy (`networking.k8s.io/v1`)

- **Một policy cho api:**
  - ingress: `apiIngressFrom` → port `http`;
  - egress: DNS, pgbouncer, redis, otel, objectStorage, idp, internet, `extra.api`.
- **Một policy cho mỗi nhóm worker:**
  - ingress: port `dashboard` từ `dashboard.ingressFrom` (mặc định rỗng: chỉ port-forward);
  - egress: DNS, pgbouncer, postgres (relay trực tiếp), redis, smtp, otel, objectStorage, clamd, internet, `extra.worker`; thêm idp cho nhóm có `dashboard: true` (Bull Board ở `external` xác thực token bằng JWKS của IdP).
- **Nhóm có tên theo vai trò** (bảng trên) là nơi dự án mở đường tới dịch vụ nội bộ mà SP6 và dự án cần: S3/MinIO trong cụm hoặc VPC interface endpoint (IP riêng, `objectStorage`), clamd TCP 3310 (`clamd`), IdP nội bộ cho `AUTH_EXTERNAL_JWKS_URL`/discovery OIDC (`idp`). Mỗi nhóm là danh sách `{ to: [peer…], ports: [{ protocol, port, endPort? }] }`; schema kiểm hình dạng (`additionalProperties: false`), kubeconform kiểm bản render.
- **`extra`** (theo vai trò `api`/`worker`/`migrate`): danh sách `NetworkPolicyEgressRule` thô, chép nguyên vào policy. Đường nào không thuộc nhóm có tên thì đi đây; dự án không phải fork template của vùng boilerplate.
- **Rule `internet`:** `ipBlock { cidr: 0.0.0.0/0, except: [0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4] }` và `{ cidr: ::/0, except: [::1/128, 64:ff9b::/96, fc00::/7, fe80::/10] }` (review plan 7B, I7: thêm "this network", IETF protocol assignments, benchmarking, multicast, reserved và NAT64 — NAT64 trỏ ngược vào IPv4 riêng). Các dải là hằng có tên trong `_helpers.tpl`. `networkPolicy.egress.internet.exceptExtra: []` nối thêm dải (v4 hoặc v6) vào except của đúng họ địa chỉ: cụm có pod/node dùng IPv6 GUA hay IP công cộng phải liệt kê dải pod, service và node của cụm ở đây, nếu không rule internet mở đường tới chính cụm (runbook 14.1 bước 6).
- **SMTP ra internet** (review plan 7B, I5): không bao giờ thêm cổng SMTP vào `RESILIENCE_ALLOWED_PORTS` (cổng đó cũng mở cho `webhooks-out` tới mọi đích internet). Nhóm `smtp` có hình dạng `{ rules: [ … ], internet: { ports: [587] } }`: `rules` như mọi nhóm (relay SMTP nội bộ); `internet.ports` sinh một rule riêng chỉ ở policy worker, đích là cùng ipBlock internet (cùng except-list và `exceptExtra`), chỉ trên các cổng đó.
- **Postgres trực tiếp cho mọi nhóm worker** (review plan 7B, m1, đã đối chiếu code): không chỉ nhóm `relay: true` — mọi worker dựng `DatabaseModule.forRoot({ relay: true })` (`app-worker.module.ts`) và dùng `RelayDb` ngoài relay: handler `core.event.dispatch` đọc outbox bằng `app_relay` (`event-dispatch.handlers.ts`), metric outbox (`observability/metrics.ts`) và readiness `DbStatementTimeoutCheck` trên pool relay. Thu hẹp egress `postgres` về nhóm relay sẽ làm nhóm `default` không Ready.
- **DNS cục bộ của node:** cụm dùng NodeLocal DNSCache (`169.254.20.10`, nằm trong link-local bị loại khỏi `internet`) ghi đè `networkPolicy.egress.dns` bằng `ipBlock 169.254.20.10/32` cổng 53 UDP/TCP. **Cổng** = danh sách `RESILIENCE_ALLOWED_PORTS` trong env hiệu lực của vai trò (`config` đè bởi `api.env`/`workers.<g>.env`): guard SSRF của app và NetworkPolicy dùng một nguồn, nên webhook tới cổng được app cho phép không bị NetworkPolicy chặn thành timeout. `internet.enabled` mà không đặt `RESILIENCE_ALLOWED_PORTS` → `fail` (chart không chép mặc định `80,443` của app).
- Egress tới hạ tầng nội bộ khai bằng `podSelector`/`namespaceSelector`/`ipBlock` cộng port trong values; rỗng thì không có rule (fail closed).
- **Kiểm trong template:**
  - `otel.enabled` mà `egress.otel` rỗng → `fail`. Riêng `endpointFromHostIP`: IP node nằm trong dải riêng bị loại khỏi `internet`, nên phải có rule `otel` (`ipBlock` của dải node) (HC-27);
  - `RESILIENCE_SSRF_ALLOW_CIDRS` khác rỗng mà không có rule nào (`idp`, `objectStorage`, `clamd`, `extra`) phủ dải đó → `NOTES.txt` cảnh báo (template không so được CIDR con một cách tin cậy nên chỉ cảnh báo).
- **Probe của kubelet** đi từ node và không bị NetworkPolicy chặn với phần lớn CNI; kind smoke chứng minh trên CNI của nó (T7-3).

### 12.7 Cửa vào

- **`HTTPRoute`** (`gateway.networking.k8s.io/v1`): `parentRefs`, `hostnames`, một rule `PathPrefix /` → Service api, `timeouts.request` = `httpRoute.requestTimeout` (30 s, lớn hơn `HTTP_REQUEST_BUDGET_MS` 20 s của §5).
- **`Ingress`** (`networking.k8s.io/v1`) tối giản.
- Không bật cả hai cùng lúc (schema `not`).
- Runbook deploy nhắc đặt `HTTP_TRUST_PROXY` đúng số hop của gateway.

### 12.8 Kiểm chữ ký image

`deploy/policy/kyverno-verify-image.yaml`: `ImageValidatingPolicy` (`policies.kyverno.io/v1`), khớp image `ghcr.io/<owner>/<repo>@sha256:*`, xác thực cosign keyless với:
- issuer `https://token.actions.githubusercontent.com`;
- subject `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v*`.

`<owner>/<repo>` là tham số dự án điền khi áp (file có chú thích; kubeconform kiểm với giá trị mẫu). Chart hỗ trợ `image.digest` để policy có digest mà xác minh. Runbook deploy: production dùng digest, không dùng tag.

(Review plan 7B, I6) Khớp theo **repository** `ghcr.io/<owner>/<repo>*` (không chỉ `…@sha256:*`, vì image cùng repo kéo bằng tag sẽ lọt qua khớp), và `validationConfigurations: { mutateDigest: false, verifyDigest: true, required: true }` (tên trường đọc từ CRD `imagevalidatingpolicy_v1` của catalog ngày 2026-10-21: `mutateDigest`, `verifyDigest`, `required`, mặc định đều `true`; đặt tường minh để đọc được ý đồ, `mutateDigest: false` vì chart đã đặt digest): image không có digest hoặc không qua chữ ký bị từ chối. Allowlist registry (chặn image ngoài `ghcr.io/<owner>/`) là policy cấp cụm của dự án, nằm ngoài chart và ngoài file mẫu này (ADR 0021).

### 12.9 CI của chart

**Job `chart` (mọi PR và push)**, chạy trên `ubuntu-latest`:
1. `azure/setup-helm` pin theo SHA, `version` lấy từ `deploy/tools.env`. Cài kubeconform từ tarball release và kiểm SHA-256 trong `tools.env`.
2. Matrix Helm `[4.3.0, 3.22.0]`: `helm lint --strict deploy/helm/saas-app -f ci/<mỗi file>`.
3. `helm template` mỗi file values → `kubeconform -strict -summary -kubernetes-version <v> -schema-location default -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'`, với `v ∈ {1.34.12, 1.37.1}`. Cùng lệnh kiểm `deploy/policy/*.yaml`.
   - (Review plan 7B, m3) URL của CRD catalog pin theo commit SHA trong `deploy/tools.env` (`CRDS_CATALOG_SHA`), không theo `main`: schema CRD đổi ở upstream không làm CI đỏ/xanh bất chợt; Renovate không nâng được (không có release), người nâng đọc diff của hai file CRD dùng.
4. `pnpm chart:secrets --check` (file sinh ra khớp code) rồi `pnpm vitest run --project deploy` (HC-1…HC-30).

**Job `kind-smoke`** chạy khi đổi `deploy/**`, `Dockerfile`, `src/main.*`, `src/core/{health,config,database}/**`, `src/modules/**/*.config.ts`, `test/deploy/**`, và hằng đêm:
- (Review plan 7B, m4) Workflow `kind-smoke` có `concurrency: { group: kind-smoke-${{ github.ref }}, cancel-in-progress: true }`: một nhánh không bao giờ có hai lần cài chồng nhau trên runner. Deploy thật của dự án (ngoài boilerplate) dùng cùng mẫu `concurrency` theo môi trường, vì Helm chỉ từ chối upgrade song song khi release đã ở `pending-*` (R7-13).
1. Build image.
2. `kind create cluster` (v0.33.0, `kindest/node` v1.34.11 pin digest; hằng đêm thêm v1.37.0).
3. `kind load docker-image`.
4. Namespace có PSA `restricted`.
5. `kubectl apply -f test/deploy/kind/infra.yaml`: Postgres với ConfigMap chứa `docker/postgres/init`, PgBouncer, Redis, Mailpit bật SMTP AUTH (`MP_SMTP_AUTH=<user>:<pass>`, `MP_SMTP_AUTH_ALLOW_INSECURE=true`; Mailpit từ chối thư khi sai mật khẩu, nên thư tới được là bằng chứng worker có `SMTP_PASSWORD`), mock-oauth2-server (IdP OIDC giả, issuer + JWKS). Tạo Secret test chứa **đủ** mọi secret; chart chỉ phát cho từng vai trò phần của nó.
6. Chạy `test/deploy/kind/smoke.sh` thực thi HC-K1…HC-K9 bằng **đúng** lệnh của runbook deploy, rollback và migration lỗi.
7. `smoke.sh` chỉ gọi route của vùng boilerplate (đăng ký → xác thực email qua Mailpit → tạo org → `/health/ready`). Bước riêng của feature mẫu chạy **chỉ khi** thư mục `src/features/example` tồn tại (kiểm trong script). Mọi bước khác của `ci.yml` nhắc tới `example` theo cùng điều kiện, nên clone đã xoá vùng template vẫn chạy được CI của boilerplate mà không sửa file nào (UP-13).

---

## 13. Quy trình upstream

### 13.1 Tệp và công cụ

| Tệp | Vùng | Nội dung |
|---|---|---|
| `.upstream/zones.json` | boilerplate | `{ version: 1, boilerplate: string[], project: string[], template: string[], generated: string[], shared: string[] }`, là các tiền tố path (mục 6.1) |
| `.upstream/version.json` | dự án | `{ tag: "vX.Y.Z", commit: "<sha 40>" }`, do `upstream:init`/`upstream:sync` ghi; upstream không có file này |
| `tools/upstream/check.mjs` | boilerplate | kiểm vùng (13.2, 13.3); `--self` cho repo upstream (UP-9) |
| `tools/upstream/sync.mjs` | boilerplate | merge một tag (13.4, state machine 8.2) |
| `tools/upstream/init.mjs` | boilerplate | khởi tạo clone (6.3.4) |
| `package.json` scripts | chung | `upstream:check`, `upstream:sync`, `upstream:init` |
| `.github/workflows/upstream-guard.yml` | boilerplate | chạy bộ kiểm trên PR và push của clone (`if: hashFiles('.upstream/version.json') != ''`), **lấy từ commit upstream**: `git show <commit>:tools/upstream/check.mjs \| node --input-type=module -` (13.2) |
| `.github/workflows/release-please.yml` | boilerplate | chỉ chạy khi `vars.BOILERPLATE_UPSTREAM == 'true'` (upstream đặt, clone không) |
| `docs/upstream/merge.md`, `CODEOWNERS.template`, `semver.md` | boilerplate | quy trình, bảng semver |

Script viết bằng Node ESM thuần, chỉ dùng `node:child_process` (`git`) và `node:fs`, không dependency: chạy được trước `pnpm install`. `check.mjs` là **một file**, không import tương đối, để chạy được từ stdin.

### 13.2 Thuật toán kiểm vùng (`upstream:check`)

Đầu vào: `HEAD`. `actions/checkout` với `fetch-depth: 0` để có lịch sử upstream đã merge.

**Chạy bộ kiểm của upstream, không phải của `HEAD`:** workflow đọc `commit` từ `.upstream/version.json`, rồi chạy `git show <commit>:tools/upstream/check.mjs | node --input-type=module -`. Một `check.mjs` bị sửa ở `HEAD` (chính nó thuộc vùng boilerplate) không thể tự nới luật để lọt; bản bị sửa vẫn bị bản của upstream báo vi phạm.

1. Đọc `.upstream/version.json` ở `HEAD`. Thiếu hoặc sai dạng → fail.
2. `git cat-file -e <commit>^{commit}` rồi `git merge-base --is-ancestor <commit> HEAD`. Không phải tổ tiên → fail: "upstream commit is not in history (squash-merged sync PR?)".
3. Đọc `zones.json` **từ commit upstream** (`git show <commit>:.upstream/zones.json`), không đọc từ `HEAD`. Dự án sửa `zones.json` không nới được luật.
4. Với mỗi path P trong `git ls-tree -r --name-only <commit>` ∪ `git ls-tree -r --name-only HEAD` mà zone(P) ∈ {boilerplate, template}:
   - boilerplate: `(mode, blob)` ở hai phía phải bằng nhau; thiếu một phía cũng là khác.
   - template: có ở `HEAD` thì phải bằng upstream; không có ở `HEAD` thì bỏ qua (đã xoá khi khởi tạo); có ở `HEAD` mà không có ở upstream → fail (dự án tạo file trong vùng template).
5. Kiểm theo khoá cho vùng chung (13.3).
6. In **mọi** vi phạm (path, loại) rồi exit 1. Không vi phạm → exit 0. Path vi phạm nằm dưới `docs/superpowers/` có thêm gợi ý "tài liệu của dự án ghi ở `docs/app/`".

`--self` (chỉ ở repo upstream, UP-9): mọi file được track khớp tường minh một vùng; file khớp vùng dự án phải thuộc `projectSeed` (S7-D36).

**Dương tính giả đã biết:** file thực thi đổi `mode` do `core.fileMode` trên Windows. `.gitattributes` của boilerplate cố định `eol`; CI chạy Linux.

### 13.3 Kiểm theo khoá (`package.json`, `pnpm-workspace.yaml`)

- **`package.json`:**
  - mọi khoá của `dependencies`/`devDependencies` ở upstream phải có ở `HEAD` với **đúng** spec;
  - dự án chỉ được thêm khoá;
  - mọi khoá của `scripts` ở upstream phải giữ nguyên; script mới của dự án phải có tiền tố `app:`;
  - `type`, `packageManager`, `engines`, `pnpm` phải bằng upstream;
  - `name`, `version`, `description`, `author`, `license`, `private` thuộc dự án.
- **`pnpm-workspace.yaml`:**
  - khoá vô hướng của upstream bằng nhau;
  - danh sách (`onlyBuiltDependencies`, …) ở `HEAD` là tập cha của upstream;
  - `catalog` giữ mọi mục của upstream với cùng giá trị.

### 13.4 Merge một bản upstream (`pnpm upstream:sync vX.Y.Z`)

Tiền điều kiện: remote `upstream` đã khai (`init` in lệnh `git remote add upstream <url>`), cây sạch, đang ở nhánh mới `chore/upstream-vX.Y.Z` tạo từ `main`.

1. `git fetch upstream --tags`. Kiểm tag có dạng `v\d+\.\d+\.\d+` và là tổ tiên của `upstream/main`. Không lùi version (tag < tag trong `version.json` → exit 1).
2. In mục "Upgrade notes" của `CHANGELOG.md` ở tag cho mọi version từ bản hiện tại tới tag; người chạy xác nhận đã đọc (tương tác).
3. `git merge --no-ff --no-commit <tag>`.
4. **Tự giải xung đột:**
   - boilerplate: `git checkout --theirs -- <path>` (vùng này luôn bằng upstream).
   - template: nếu bên mình đã xoá → `git rm`; ngược lại lấy bản upstream.
   - sinh ra: lấy bản upstream (sẽ sinh lại ở bước 6).
   - dự án và chung: giữ nguyên, liệt kê, exit 3 (`MERGING_MANUAL`). Hướng dẫn cho từng file chung nằm ở `docs/upstream/merge.md`: `package.json` giữ spec của upstream cho khoá của upstream và giữ khoá thêm của dự án; `renovate.json` gộp `packageRules`; `.gitignore`/`.dockerignore`/`.gitleaksignore` hợp hai tập.
5. `--continue` sau khi người sửa xong: kiểm không còn path chưa merge.
6. **Sinh lại:** `pnpm install` (cập nhật lockfile), `pnpm env:example`, `pnpm build && pnpm openapi:export`. Ghi `.upstream/version.json` = `{ tag, commit: <sha của tag> }`.
7. **Kiểm:** `pnpm install --frozen-lockfile`, `pnpm upstream:check`, `pnpm lint`, `pnpm test`. In lệnh `git commit` và nhắc mở PR.
8. **PR đồng bộ phải merge bằng "Create a merge commit"**, không squash, không rebase.
   - **Phòng trước:** `docs/upstream/merge.md` khuyến nghị ruleset của repo cho `main` chỉ cho phép merge commit (tắt squash và rebase); nếu dự án cần squash cho PR thường, ruleset chỉ cho merge commit với nhánh `chore/upstream-*`. Mô tả PR (script in sẵn) ghi rõ.
   - **Phát hiện:** guard chỉ thấy squash **sau** khi đã merge, ở lần chạy trên `main` (UP-6): lúc đó `main` đã đỏ.
   - **Khôi phục** (UP-6b): trên nhánh mới từ `main`, `git merge -s ours --no-ff <tag>` (tag trong `.upstream/version.json`). Chiến lược `ours` giữ nguyên cây (cây của `main` đã đúng là kết quả sync), chỉ thêm commit của tag làm cha, nên quan hệ tổ tiên được khôi phục. Mở PR, merge bằng merge commit. `docs/upstream/merge.md` có đủ lệnh.

**Job CI "upgrade path"** (trong `upstream-guard.yml`, chạy khi PR đổi `.upstream/version.json`):
- build `HEAD^1` (phía dự án trước merge) và `HEAD`;
- trên một Postgres service container: `migrate up` bằng bản cũ, rồi `migrate up` bằng bản mới. Đây là đúng thứ tự production gặp (migration upstream timestamp cũ chạy sau migration của dự án, S7-D31);
- `migrate status` rỗng;
- khởi động api bản mới tới `/health/ready`.

### 13.5 Tránh xung đột (luật cho dự án, `docs/upstream/merge.md`)

1. Không sửa vùng boilerplate; tuỳ biến qua bốn cách của §1.1.
   - Config.
   - Adapter (`@Global()` + `@Optional()`).
   - Domain event.
   - Bỏ module (`disable`).
2. Định danh mang tiền tố tên feature (S7-D27); trùng lặp fail lúc boot, lúc migration, hoặc ở kiểm trùng route.
3. Migration của dự án tạo đối tượng của dự án và chỉ **chèn dòng** catalogue/seed vào bảng boilerplate được phép (`permissions`, `permission_requires`, `plans`, `entitlement_features`, …); không `ALTER`/`DROP` bảng hay hàm của boilerplate (S7-D31). Được FK tới `organizations`/`tenancy_users` và dùng `app_current_org()`/`sweep_definer` theo mẫu. Gỡ dòng catalogue đã được dùng thì theo vòng đời của module chủ (SP3 §8.8, SP4 §8.4).
4. Test của dự án chỉ ở `test/*/features/`. Khai báo inventory qua `*.inventory.ts` (S7-D28).
5. Workflow của dự án đặt tên `app-*.yml`. Service compose thêm ở `compose.override.yaml`. Values deploy ở `deploy/values/`.
6. ADR và runbook của dự án ở `docs/adr/app/`, `docs/runbooks/app/`; spec, plan và tài liệu khác ở `docs/app/`. Luật dependency-cruiser thêm ở `.dependency-cruiser.app.cjs`; khai báo kiểu bổ sung ở `src/types/app/`.
7. Merge upstream thường xuyên (mỗi bản minor). Không bỏ qua nhiều bản major cùng lúc.

### 13.6 Phát hành upstream

- **release-please** (`release-type: simple`, `release-please-config.json`, S7-D10):
  - version nằm ở `.release-please-manifest.json`; file version mà strategy `simple` tự cập nhật (mặc định `version.txt`) là file vùng boilerplate; 7A đọc lại tên file mặc định này từ source release-please mà `release-please-action` v5.0.0 kèm, trước khi viết config;
  - **không** cập nhật `package.json.version` (thuộc dự án, 13.3), nên sync không xung đột ở dòng đó;
  - `changelog-sections` gồm `feat`, `fix`, `perf`, `refactor`, `docs`;
  - `extra-files`: `deploy/helm/saas-app/Chart.yaml` (`version`, `appVersion` qua marker `# x-release-please-version`).
  - PR phát hành gom commit; merge PR đó tạo tag `vX.Y.Z` và GitHub release. `release.yml` có sẵn build image, ký cosign.
- **Upgrade notes:** mọi PR có `src/migrations/**` ngoài `app/`, env mới hoặc đổi, hoặc đổi export ở `index.ts` của core/module phải có mục "## Upgrade notes" trong mô tả PR (template PR có sẵn mục này). Người duyệt PR phát hành chép vào CHANGELOG của release. Mỗi migration ghi tác động khoá như bảng 6.13 của SP3.
- **Semver** (`docs/upstream/semver.md`):
  - **Major:** xoá hoặc đổi nghĩa env; xoá hoặc đổi export ở `index.ts` của `core/*` hay `modules/*`; đổi bảng/hàm/role mà feature được phép tham chiếu (`organizations`, `tenancy_users`, `app_current_org`, `sweep_definer`, bảng catalogue nhận dòng seed); đổi chữ ký helper quét của core hoặc API công khai của SP4 mà mẫu dùng; breaking của `oasdiff`; đổi `values.schema.json` theo hướng từ chối values cũ; nâng major Node/Postgres/Kubernetes tối thiểu.
  - **Minor:** thêm module, env, export, route, values.
  - **Patch:** sửa lỗi không đổi hợp đồng.

---

## 14. Runbook (`docs/runbooks/`)

Mỗi runbook có cùng khung: **Tín hiệu** (alert hoặc triệu chứng), **Tác động**, **Chẩn đoán** (lệnh cụ thể), **Hành động**, **Kiểm lại**, **Leo thang**, **Sau sự cố**. Quy ước lệnh:
- `REL` là release, `NS` là namespace;
- `kubectl -n $NS`;
- CLI trong pod: `kubectl -n $NS exec -it deploy/$REL-saas-app-api -- /nodejs/bin/node dist/…` (distroless không có shell; `-t` đưa output ra terminal, không vào log container).

`docs/runbooks/alerts.md` là bảng metric → ngưỡng gợi ý → runbook (§12 "mỗi cảnh báo có runbook"). Ngưỡng là gợi ý; dự án đặt theo SLO.

### 14.1 Deploy (`deploy.md`)

1. **Trước khi deploy:**
   - đọc Upgrade notes;
   - migration có khoá `ACCESS EXCLUSIVE` hoặc `SHARE ROW EXCLUSIVE` trên bảng nóng → chọn cửa sổ ít ghi;
   - lấy digest: `cosign verify <image>@<digest> --certificate-identity-regexp '…/release.yml@refs/tags/v.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`;
   - `helm diff` (nếu có plugin) hoặc `helm template` so với release hiện tại.
2. **Lệnh (Helm ≥ 4.3; Helm 3.22 chỉ dùng cho lint/template trong CI, cú pháp cờ khác):**
   `helm upgrade --install $REL deploy/helm/saas-app -n $NS -f deploy/values/<env>.yaml --set image.digest=<digest> --wait --timeout <T_min>s`
   - `--wait` không giá trị = chiến lược `watcher` của Helm 4.3: chờ mọi tài nguyên sẵn sàng.
   - `T_min = migrate.activeDeadlineSeconds + ceil(DB_MIGRATION_STATEMENT_TIMEOUT_MS / 1000) + 60` giây; `NOTES.txt` của lần cài trước in sẵn số này (12.4). `--timeout` áp cho từng thao tác, nên cũng đủ cho rollout các Deployment (`progressDeadlineSeconds: 300`).
   - Không dùng `--atomic` hay `--force` (deprecated ở Helm 4). Không dùng `--rollback-on-failure` mặc định: release lỗi được giữ nguyên để đọc Job và sự kiện; rollback là bước có chủ đích (14.2). Dự án muốn tự rollback thì dùng `--rollback-on-failure` (nó bao hàm `--wait=watcher`).
   - Hook migrate chạy trước; Job lỗi thì log của nó in ngay trong output nhờ `hook-output-log-policy: hook-failed`.
3. **Kiểm:**
   - `kubectl rollout status` từng Deployment;
   - `/health/ready`;
   - `outbox_lag_seconds`, `queue_oldest_job_age_seconds`, tỉ lệ 5xx trong 15 phút;
   - job migrate `Complete` và log có danh sách migration.
4. Đổi secret ở nguồn ngoài thì cần `kubectl rollout restart deploy -l app.kubernetes.io/instance=$REL`.
5. **Bật HPA trên release đang chạy** (12.3): làm trong cửa sổ ít tải; ngay sau lệnh ở bước 2, `kubectl -n $NS scale deploy/<tên> --replicas=<hpa.minReplicas>`; theo dõi `kubectl -n $NS get hpa`.
6. **Egress:** Deployment đầu tiên lên một cụm mới thì kiểm CNI có thực thi NetworkPolicy (15, ngoài phạm vi) và các nhóm egress (`objectStorage`, `clamd`, `idp`, `extra`) đã khai cho dịch vụ nội bộ đang dùng; thiếu rule biểu hiện là timeout tới dịch vụ đó, không phải lỗi `4xx`.
7. **(Review plan 7B, I7) Cụm IPv6/GUA hoặc pod dùng IP công cộng:** dải pod, service, node của cụm không nằm trong except-list mặc định; đặt chúng vào `networkPolicy.egress.internet.exceptExtra`, nếu không rule internet mở đường từ pod tới chính cụm. NodeLocal DNSCache (`169.254.20.10`): ghi đè `networkPolicy.egress.dns`.
8. **(Review plan 7B, I1) Chạy lại `helm upgrade` sau timeout hay lỗi:** trước khi chạy lại, `kubectl -n $NS get job -l app.kubernetes.io/component=migrate` không còn Job `ACTIVE`, và `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'saas-migrator-lock'` = 0 (bằng role có quyền đọc mọi phiên). Còn thì chờ Job xong (hoặc tới `activeDeadlineSeconds`) — không xoá Job đang giữ khoá; xoá tay chỉ khi phiên khoá đã không còn.
9. **(Review plan 7B, m4) Release kẹt `pending-install`/`pending-upgrade`** (process Helm chết giữa chừng): `helm history $REL` xác định revision `deployed` cuối; nếu không có Job migrate `ACTIVE` (bước 8), `helm rollback $REL <rev deployed cuối> --wait --timeout 10m` đưa release về trạng thái nhận upgrade; không sửa Secret release của Helm bằng tay.
10. **(Review plan 7B, m5) Gỡ release:** `helm uninstall` không xoá resource hook (Job migrate các revision còn trong TTL, NetworkPolicy của Job): xoá tay bằng `kubectl delete job,networkpolicy -l app.kubernetes.io/instance=$REL,app.kubernetes.io/component=migrate`.

### 14.2 Rollback (`rollback.md`)

- **Khi nào:** 5xx hoặc lỗi nghiệp vụ tăng sau deploy, và không có bản vá tiến nhanh hơn.
- **(R-X36) Chọn revision:** đối chiếu `helm history $REL` (cột `APP VERSION`/chart) với Upgrade notes của mọi release nằm giữa revision hiện tại và revision định về. Không về revision có image cũ hơn bước đầu của một release "deploy hai bước" (ví dụ image trước 4B PR 1 trên DB đã có `…_usage_counters`: pod cũ crash-loop) hay cũ hơn một migration không tương thích ngược. Khung cửa sổ im lặng còn lại (override 4C bị bỏ qua, fan-out 6C bị bỏ trên image cũ) chỉ được chặn bằng DB ở follow-up 7E (R-X36: bảng `schema_compat(min_code_version)` + kiểm lúc boot); 7B chỉ ship bước runbook này.
- `helm history $REL`, rồi `helm rollback $REL <rev> --wait --timeout 10m` (Helm ≥ 4.3; `--wait` không giá trị = `watcher`; `helm rollback` nhận `--wait`, `--timeout`, `--cleanup-on-fail`).
  - Rollback **không** chạy migrate: hook chỉ là `pre-install,pre-upgrade`.
  - Schema giữ ở bản mới; code cũ vẫn chạy nhờ expand → contract (§4).
  - Job payload có version, nên worker cũ và mới cùng chạy được (§13.1).
- **Không bao giờ** tự `migrate down` khi rollback. Chỉ khi migration mới **phá** code cũ (vi phạm expand/contract), theo 14.3 nhánh "down có chủ đích".
- **Kiểm:** như 14.1. Mở sự cố cho bản lỗi.

### 14.3 Migration lỗi (`migration-failure.md`)

- **Tín hiệu:** `helm upgrade` fail ở hook, output đã kèm log của Job (`hook-output-log-policy: hook-failed`); `kubectl get job -l app.kubernetes.io/component=migrate`.
- **Tác động:** runner all-or-nothing, nên schema không đổi và pod cũ giữ nguyên (không Deployment nào được cập nhật). Ngoại lệ: migration không transactional (`CONCURRENTLY`) có thể để lại index `INVALID`.
- **Chẩn đoán:** log trong output của `helm upgrade`, hoặc `kubectl logs job/$REL-saas-app-migrate`. Phân loại theo SQLSTATE hoặc thông điệp:

  | Lỗi | Hành động |
  |---|---|
  | `lock_timeout` (`55P03`) | tìm blocker (`SELECT pid, wait_event_type, query FROM pg_stat_activity WHERE …`, `pg_locks`); chạy lại trong cửa sổ ít tải |
  | `statement_timeout` (`57014`) | backfill quá lớn; tách theo expand → backfill → contract ở bản vá upstream hay migration app |
  | "Another migration run holds the migration lock" | chờ, hoặc tìm Job/lệnh tay đang chạy |
  | `RAISE` có chủ đích của `down` (dữ liệu chặn) | theo thông điệp |
  | index `INVALID` | `DROP INDEX CONCURRENTLY` rồi chạy lại |
  | lỗi khác | leo thang upstream (migration boilerplate) hoặc team dự án (`src/migrations/app`) |

- **Chạy lại:** `helm upgrade` cùng lệnh, sau điều kiện của 14.1 bước 8 (không Job migrate `ACTIVE`, không phiên `saas-migrator-lock`).
- **Down có chủ đích:**
  `helm template $REL deploy/helm/saas-app -n $NS -f deploy/values/<env>.yaml --set image.digest=<digest đang deploy> --show-only templates/migrate-job.yaml --set migrate.args='{down,<Migration…>}' --set migrate.nameSuffix=-down-<ticket> | kubectl -n $NS apply -f -`
  - **Cùng** file values và **cùng** digest với release đang chạy (`helm get values $REL`, `kubectl get deploy … -o jsonpath` lấy image): code `down` của migration mới nằm trong image mới; thiếu values thì schema fail.
  - Pod của Job mang `component: migrate` nên khớp NetworkPolicy hook còn lại từ lần upgrade trước (12.4).
  - Runner từ chối target không nằm trong danh sách đã chạy. Down của SP3/SP4/feature có thể `RAISE` hoặc fail `23503` khi dữ liệu chặn (ví dụ mẫu, 7.5); không bao giờ ép.

### 14.4 Queue tồn đọng (`queue-backlog.md`)

- **Tín hiệu:**
  - `queue_oldest_job_age_seconds{queue}` vượt ngưỡng (SLO thông báo: 99% bắt đầu trong 60 s);
  - `queue_depth` tăng liên tục;
  - `outbox_lag_seconds` > 30 s (§10);
  - `outbox_parked_events` > 0;
  - tốc độ `queue_failed_total` tăng.
- **Chẩn đoán:**
  1. Queue có consumer không: nhóm nào consume (`values: workers.*.queues/queuesExclude`); pod `Ready` không.
  2. `kubectl exec … dist/scripts/queue-admin.js stats`: depth, active, failed, paused theo queue.
  3. Redis: bộ nhớ (`noeviction` đầy → enqueue lỗi, SafeEnqueue chuyển sang outbox), độ trễ.
  4. DB: worker hết connection (`DB_WORKER_CONNECTION_TIMEOUT_MS`), khoá.
  5. Handler lỗi lặp: log `job failed` theo `job`.
  6. Relay và cron dọn dẹp/tỏa ra: nhóm `scheduler` sống không (relay chỉ chạy ở đó; job của cron theo quy ước S7-D34 ở `maintenance`). Cron nào đặt job ở queue khác thì do nhóm consume queue đó chạy.
- **Hành động:**
  - Scale nhóm: HPA max, hoặc `kubectl scale` khi HPA tắt.
  - Tách queue nóng sang nhóm riêng (values): thêm nhóm có `queues: [<q>]` **và** thêm `<q>` vào `queuesExclude` của `default`; template từ chối values thiếu bước sau (12.1, HC-25).
  - Handler lỗi: `queue-admin pause --queue <q> --ticket <id>` để ngừng đốt retry → vá → `resume` → `retry-failed --queue <q> [--job <name>] [--max <n>] --ticket <id>`. Có `--job`/`--max` thì log ghi đúng số job đã retry (`affected`) và số bỏ qua (`skipped`); không có thì retry mọi job `failed` của queue và `affected` là `null` (BullMQ không trả số lượng).
  - Event bị park: sửa nguyên nhân, rồi DBA chạy `UPDATE outbox_events SET publish_attempts = 0 WHERE id = ANY($1) AND published_at IS NULL` bằng role có quyền (`app_relay`, hoặc owner qua cửa sổ vận hành); relay tự lấy lại.
  - Relay chết: kiểm pod `scheduler`; relay chạy lại tiếp tục an toàn nhờ lease và jobId trùng.
- **Kiểm:** gauge về ngưỡng; không còn failed mới.

### 14.5 DB failover và PgBouncer (`db-failover-pgbouncer.md`)

- **Tín hiệu:**
  - api `503 service_unavailable` hàng loạt;
  - readiness api/worker đỏ (DB);
  - log `pool` timeout;
  - `DbStatementTimeoutCheck` đỏ.
- **Mô hình:**
  - api và worker (pool app và auth) đi qua PgBouncer transaction mode;
  - relay (`DB_RELAY_HOST`) và migrate (`DB_MIGRATION_HOST`) đi **thẳng** Postgres.
  - Sau failover, **cả hai** endpoint phải trỏ primary mới.
- **Postgres failover** (managed có standby):
  1. Xác nhận primary mới và DNS đã đổi.
  2. PgBouncer: `SHOW SERVERS` trên admin console; server connection còn trỏ primary cũ thì `RECONNECT` (hoặc `RELOAD` sau khi đổi host). Kiểm `server_lifetime`, `dns_max_ttl`. Lệnh admin chốt theo bản 1.25.2 ở plan 7E.
  3. Pod app không cần restart: pool bỏ connection hỏng (`destroyUnusableClients`), request lỗi là `503` rồi tự hồi.
  4. Kiểm `/health/ready` và `pg_stat_activity` trên primary mới.
- **PgBouncer lỗi hoặc restart:** api `503`, worker job retry theo backoff. Kiểm:
  - `MAX_PREPARED_STATEMENTS > 0` (bắt buộc: `RateLimiterPostgres` dùng named prepared statement, spike S2b);
  - userlist có `app_user` **và** `auth_user`;
  - `pool_mode = transaction`;
  - `max_client_conn` ≥ budget (12.5).
- **Khôi phục từ backup** (PITR hoặc snapshot, RTO ≤ 1 giờ):
  - Khôi phục cả cluster giữ role và `ALTER ROLE … SET statement_timeout`.
  - Khôi phục logic (`pg_dump`) **mất** role: chạy lại `docker/postgres/init/01-roles.sh` (idempotent, S2-R18) trước khi mở app. Readiness đỏ vì `statement_timeout` sai là tín hiệu thiếu bước này.
  - Outbox chưa publish được relay gửi tiếp; job trùng bị inbox chặn.
- **Rủi ro dữ liệu:** transaction đang commit lúc failover → `503 commit_outcome_unknown`. Client retry cùng `Idempotency-Key` (ADR 0007). Nhắc SLO RPO 5 phút.

### 14.6 Reset 2FA nhân viên (`staff-2fa-reset.md`)

Chép nguyên văn quy trình SP3 §9.7 (5): điều kiện dùng, bước 0–4, mã thoát 1 và 2, "chạy lại đúng lệnh", rà soát sau exit 2. Thêm phần đặc thù môi trường:
- **Kubernetes:** `kubectl -n $NS exec -it deploy/$REL-saas-app-api -c api -- /nodejs/bin/node dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js --user-id <id> --ticket <ticket> [--for-promotion]`.
  - `APP_ROLE=api` đã có trong env của container (S7-D32).
  - Pod api có đúng env của pool `auth_user`.
  - `-it` cho TTY ở cả stdin lẫn stdout, nên mật khẩu tạm chỉ ra terminal của vận hành, không vào log container.
  - **Không** dùng `--password-file` trên Kubernetes: rootfs chỉ đọc, `/tmp` là `emptyDir`, distroless không có `cat`/`tar` để lấy file ra.
  - Audit log của API server ghi lệnh `exec` (có `--user-id`, `--ticket`, không có secret).
- **Compose:** `docker compose --env-file … --profile app run --rm -it api dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js …` (SP3 (vii): `run --rm`; hoặc `--password-file` trên host).
- **Sau khi chạy:**
  - gửi mật khẩu tạm qua kênh ticket;
  - nhân viên đăng nhập → `enable` → `verify-totp` → step-up → đổi mật khẩu;
  - nếu nghi lộ: rà `oak_` của user qua route tenancy (ranh giới (x) của SP3).

### 14.7 Xoay khoá (`key-rotation.md`)

| Khoá | Quy trình | Gián đoạn |
|---|---|---|
| `FIELD_ENCRYPTION_KEYS` | (1) Thêm kid mới vào JSON ở secret manager, **giữ** kid cũ → rollout restart. (2) Đổi `FIELD_ENCRYPTION_ACTIVE_KID` → rollout restart. (3) Chờ `encrypted_rows{keyring="field", key="<kid cũ>"}` = 0 ở mọi tập `REWRITE` (cron `core.security.reencrypt`), và ở tập `EXPIRE` sau `NOTIFICATIONS_RETENTION_DAYS`. (4) `encrypted_rows{key="unknown"}` = 0 và `encrypted_rows_undecryptable_total` không tăng. (5) Bỏ kid cũ → rollout restart | Không |
| Secret Better Auth (nhánh A, T7-1 đạt) | (1) Đặt `AUTH_SECRETS = {"1": <mới>}`, `AUTH_SECRET_CURRENT_VERSION = 1`; giữ `BETTER_AUTH_SECRET` = secret cũ (legacy) → rollout. Mọi session cookie và bearer mất hiệu lực (chữ ký dùng secret hiện tại); 2FA và JWKS vẫn chạy. (2) Chờ `encrypted_rows{keyring="auth", key!="1"}` = 0. (3) Bỏ `BETTER_AUTH_SECRET` → rollout. Lần xoay sau: thêm `"2"`, đổi current, chờ, bỏ `"1"` | Mọi user đăng nhập lại |
| Secret Better Auth (nhánh B, T7-1 không đạt) | Quy trình có gián đoạn của README SP2: thông báo trước, đổi secret, mọi user bật lại 2FA, JWKS sinh cặp khoá mới | Lớn |
| JWKS | Tự xoay theo `AUTH_JWKS_ROTATION_INTERVAL_SEC`/`AUTH_JWKS_GRACE_PERIOD_SEC`. Khoá bị lộ: quy trình khẩn cấp chốt ở plan 7E sau khi đọc `plugins/jwt` 1.7.6 (xoá dòng `auth.jwks` bị lộ → token ký bằng nó không còn verify) | Token ký bằng khoá đó |
| Password role DB | (1) Cập nhật secret (app **và** userlist PgBouncer). (2) `ALTER ROLE <r> PASSWORD …` bằng superuser. (3) `rollout restart` ngay (connection đang mở không bị ngắt; connection mới của pod cũ fail cho tới khi restart xong). Postgres chỉ giữ một mật khẩu mỗi role | Vài giây `503` rải rác |
| Redis ACL | `ACL SETUSER <u> >newpass` (thêm) → cập nhật `REDIS_URL` → rollout → `ACL SETUSER <u> <oldpass` (bỏ). Redis cho một user nhiều mật khẩu | Không |
| SMTP, OAuth client secret | Theo provider: tạo secret mới song song nếu provider cho → đổi → rollout → thu hồi cũ | Tuỳ provider |
| API key user, org API key | Người dùng tự xoay: tạo mới → cập nhật client → xoá cũ (SP2, SP3) | Không |
| Secret ký webhook (SP6), key SePay (SP5) | SP của chúng thêm dòng vào bảng này | — |

---

## 15. Bảo mật và mô hình đe doạ

**Kẻ tấn công trong phạm vi:**

| Kẻ tấn công | Mục tiêu | Chặn bằng |
|---|---|---|
| Member org A | đọc/sửa project org B | org từ path + 404 thống nhất (SP3); RLS FORCE `TO app_user`; `WITH CHECK` chặn ghi `org_id` khác; FK `RESTRICT` (EX-I1…EX-I5) |
| Member thiếu quyền, org API key, support grant | vượt quyền | catalogue (`delete` chỉ ADMIN, không `apiKeyEligible`; support chỉ `read`); `PoliciesGuard` fail-closed (EX-E9) |
| Client gửi đồng thời | vượt quota, tạo trùng | quota nguyên tử (SP4), unique index, `Idempotency-Key` (R7-1…R7-3) |
| Client gửi `If-Match` cũ | ghi đè mất cập nhật | `UPDATE … WHERE version = ?` → `412` (R7-4) |
| Pod app bị chiếm (RCE qua dependency) | đọc secret khác, gọi mạng nội bộ/metadata, sửa code | secret theo vai trò (12.5); rootfs chỉ đọc; `drop: [ALL]`; không token ServiceAccount; NetworkPolicy chặn dải riêng và metadata (12.6); user 65532 |
| Người viết values | đưa secret vào ConfigMap hoặc Git | schema từ chối đúng các tên secret sinh từ code (không đoán theo regex), cả ở `config`, `api.env`, `workers.*.env`; chart không có template `Secret` (HC-5, HC-6, HC-30) |
| Image giả hoặc không ký | chạy code lạ | digest + policy Kyverno xác minh cosign identity của `release.yml` (12.8) |
| Lập trình viên dự án (vô ý) | sửa `core/` (kể cả sửa chính `check.mjs`), giải xung đột sai, squash PR sync | guard so cây chạy bản `check.mjs` của commit upstream (13.2), kiểm theo khoá (13.3), ancestor check (UP-6) + quy trình khôi phục (UP-6b) |
| Dependency CI | thay tool Helm/kubeconform | pin version + SHA-256; action pin SHA |
| Hàm definer bị gọi với tham số độc | quét dữ liệu | chỉ trả `org_id`; kiểm biên và `NULL`; `search_path = ''`; `EXECUTE` chỉ cho `app_user` |
| Vận hành gõ nhầm lệnh ghi queue | retry hoặc pause nhầm | `--ticket`, xác nhận gõ lại, TTY bắt buộc, log WARN (QA-3) |

**Ngoài phạm vi** (có tên):
- Người có quyền admin repo dự án. Họ sửa được workflow và tắt guard: workflow `pull_request` chạy bản của PR. Lớp chặn cố ý là CODEOWNERS + branch protection (6.1), không phải CI. (7A, review M1: `.github/CODEOWNERS` và `.upstream/version.json` thuộc vùng dự án nhưng do team nền sở hữu trong `docs/upstream/CODEOWNERS.template`: team dự án tự sửa CODEOWNERS thì gỡ được lớp chặn này, còn `version.json` chọn bản `check.mjs` mà CI chạy.)
- Quản trị cụm Kubernetes, hoặc người đọc được Secret của namespace.
- Repo upstream bị chiếm. Dự án tin tag upstream; lớp giảm thiểu là đọc diff và Upgrade notes khi sync.
- Kẻ có credential `app_owner`/superuser.
- Kênh bên.
- CNI không thực thi NetworkPolicy: chart vẫn render đúng; runbook deploy nhắc kiểm CNI.

**Không PII:**
- event mẫu chỉ có id;
- log không có tên/mô tả project;
- metric không có nhãn org;
- lệnh CLI không in secret.

---

## 16. Race condition có tên

| # | Tình huống | Cơ chế chặn | Test |
|---|---|---|---|
| R7-1 | Tạo song song vượt quota | `consumeOrThrow` của SP4: một câu `INSERT … ON CONFLICT DO UPDATE … WHERE used + n <= limit` (SP4 §9.2), tuần tự hoá trên khoá dòng bộ đếm, trong cùng transaction với `INSERT` project; bên hết quota rollback cả dòng vừa chèn | EX-E7 |
| R7-2 | Tạo song song trùng tên | `example_projects_name_uq` → `409` | EX-E4 |
| R7-3 | Cùng `Idempotency-Key` song song | core idempotency: một `201`, một `409 idempotency_conflict`, rồi replay | EX-E3 |
| R7-4 | Hai `PATCH` cùng `If-Match` | `UPDATE … WHERE version = ?` (một thắng, một `412`) | EX-E5 |
| R7-5 | `unarchive` ∥ job xoá | `SKIP LOCKED` ở job; `unarchive` là `UPDATE … WHERE status = 'ARCHIVED'`. Job xoá trước → `unarchive` 0 dòng → `404`. `unarchive` trước → job bỏ qua dòng | EX-I9 |
| R7-6 | `DELETE` tay ∥ job xoá (release quota hai lần) | quota chỉ `releaseAllocation` đúng số dòng `DELETE … RETURNING` trả về trong transaction của mình | EX-I10 |
| R7-7 | Tạo project ∥ xoá cứng org | Thực tế không xảy ra qua HTTP: purge chỉ chạy sau `purge_after` của org đã xoá mềm, còn `OrgContextMiddleware` trả `404` cho org xoá mềm, nên không request tạo nào còn sống khi purge chạy. Về cơ chế: `INSERT` lấy `FOR KEY SHARE` trên dòng org (không xung đột `FOR NO KEY UPDATE` của purge); nếu tạo commit sau khi participant đã xoá, `DELETE organizations` gặp `23001` → purge rollback và retry. Nếu purge đã xoá dòng bộ đếm (participant SP4, order 100) trước khi tạo tiêu quota, hai bên chờ nhau (tạo chờ dòng bộ đếm đang bị xoá; purge chờ khoá `FOR KEY SHARE` khi xoá `organizations`) → Postgres phát hiện `40P01`, huỷ một bên; `UnitOfWork` và BullMQ retry. Không mồ côi, không lệch bộ đếm | EX-I6b |
| R7-8 | Deadlock giữa tạo và xoá quanh bộ đếm | Thứ tự khoá cố định ở **mọi** đường: dòng nghiệp vụ → bộ đếm (S7-D35). Tạo: `INSERT` (dòng mới, không ai thấy) rồi consume; xoá tay và job xoá: `DELETE … RETURNING` rồi `releaseAllocation`. Bên nào đã giữ bộ đếm thì không còn chờ dòng project nào, nên không có chu trình. Participant purge không đụng bộ đếm của mẫu | EX-I11 |
| R7-9 | Hai lượt cron tỏa ra cùng org | `jobId` theo slot của helper (per R-X4): mỗi slot một job; hai job chồng nhau tách rời nhờ `SKIP LOCKED` | EX-I12 |
| R7-10 | Mã hoá lại ∥ app ghi giá trị mới (Better Auth làm mới token) | compare-and-swap `WHERE col = $old`; 0 dòng → `skipped` (giá trị mới đã dùng kid active) | KR-4 |
| R7-11 | Hai worker chạy cron mã hoá lại cùng lúc | cùng CAS: lần ghi thứ hai 0 dòng. Cron tĩnh chỉ một job mỗi mốc (BullMQ) | KR-5 |
| R7-12 | Hai migrator (hook + lệnh tay), kể cả khi lượt đầu chạy lâu | `pg_try_advisory_lock` trên `pg.Client` riêng giữ suốt lượt chạy (S7-D24): pool của MikroORM đóng connection rảnh cũng không nhả khoá; `unlock` chạy trên đúng phiên giữ khoá. Helm tự khoá release khi `pending-upgrade` | CO-2, CO-2b |
| R7-13 | Hai `helm upgrade` cùng lúc | Helm từ chối khi release đang `pending-*` | runbook 14.1 |
| R7-14 | Pod mới (schema mới) ∥ pod cũ trong rolling update | expand → contract; payload job có version; hook migrate xong trước khi pod mới lên | HC-K3 |
| R7-15 | `queue-admin retry-failed` ∥ worker/BullMQ đổi trạng thái job | Chụp danh sách id trước, rồi `job.retry('failed')` từng job: BullMQ chỉ chuyển job đang `failed` và ném khi job đã đổi trạng thái, đang khoá hay đã bị dọn → đếm `skipped`, không retry hai lần. `retryJobs` (không lọc) cũng chỉ chuyển job `failed`. Handler idempotent (inbox, CAS) | QA-4 |
| R7-16 | Hai người chạy `upstream:sync` trên hai nhánh | Git: PR merge sau gặp xung đột ở `.upstream/version.json` và phải sync lại; guard kiểm ancestor | UP-11 |
| R7-17 | Tắt module ∥ rolling deploy (pod bản cũ vẫn bật module, sync cron lúc khởi động) | `StaticScheduler.sync()` chỉ chạy lúc boot; pod bản mới gỡ `static-<m>.*`, pod bản cũ khởi động lại trong lúc rollout có thể upsert lại, và pod bản mới kế tiếp gỡ tiếp. Hết rollout thì ổn định ở trạng thái đã gỡ. Job cron sinh ra trong khoảng đó nằm ở queue không ai consume (bản mới) hoặc được bản cũ chạy như trước: không sai dữ liệu | UP-12b |
| R7-18 | Tạo tên "a" ∥ xoá tay dòng "A" chưa commit (cùng `lower(name)`) | `INSERT` chờ ở unique index tới khi transaction xoá kết thúc. Với thứ tự S7-D35, bên tạo chưa giữ bộ đếm lúc chờ, nên bên xoá lấy được bộ đếm và commit; bên tạo tiếp tục. Với thứ tự r0 (consume trước) đây là chu trình `40P01` | EX-I11 (ca cùng tên) |
| R7-19 | (Review plan 7B, I1) Chạy lại `helm upgrade` khi Job migrate của revision trước còn chạy (sau timeout của Helm) | Tên Job theo revision: `before-hook-creation` không xoá Job cũ; khoá advisory (R7-12) cho Job thứ hai exit 1 có tên; runbook 14.1 bước 8 kiểm trước khi chạy lại; `ttlSecondsAfterFinished` dọn Job xong | HC-K10 |
| R7-20 | (Review plan 7B, I2) Process migrator chết (SIGKILL, mất TCP) khi câu dài đang chạy: khoá phiên nhả ngay nhưng backend của pool ORM còn chạy câu đó | `client_connection_check_interval` trên mọi phiên migrator: backend tự huỷ câu khi client mất; phiên khoá mất → `MigrationLockLostError` huỷ lượt và đóng pool | CO-2c |

---

## 17. Failure mode

| Lỗi | Hành vi | Phát hiện |
|---|---|---|
| Hook migrate fail | release `failed`, Deployment không đổi, Job giữ lại để đọc log | `helm status`, runbook 14.3 |
| Hook quá `--timeout` của Helm | Helm báo fail trong khi Job có thể vẫn chạy. Khoá advisory chặn lần chạy thứ hai | NOTES in `T_min = D + G + 60`; runbook 14.1 dùng đúng số đó |
| Namespace có default-deny, cài lần đầu | NetworkPolicy của Job là hook weight −10, có trước Job | HC-K1 |
| Config sai (zod) | pod `CrashLoopBackOff`, log `ConfigValidationError` (không in giá trị); rollout không tiến (maxUnavailable 0) | `progressDeadlineSeconds` |
| Vai trò thiếu secret mà luật config đòi | không xảy ra với values đúng: allowlist và luật cùng sinh từ metadata, CO-4 chứng minh mỗi vai trò đủ. Values khai secret cho sai vai trò → `helm template` fail (HC-7) | CO-4, HC-K9 |
| Secret thiếu khoá | pod `CreateContainerConfigError` | `kubectl describe` |
| Thiếu rule egress tới dịch vụ nội bộ (MinIO, clamd, IdP, webhook cổng lạ) | kết nối timeout (NetworkPolicy thả gói), không phải `4xx` | runbook 14.1 bước 6; nhóm egress 12.6 |
| Module bị tắt còn job trong queue của nó | job nằm im (không consumer); cron của module đã bị gỡ | `docs/boilerplate/README.md` "Tắt module": pause + chờ queue rỗng trước khi tắt |
| Feature import module bị tắt | boot fail với tên module (bước 4 của `composeAppModules`) | UP-12c |
| DB sập | api `503`, readiness đỏ ở mọi pod (LB trả lỗi), worker retry | runbook 14.5 |
| Redis sập | api giảm chức năng (R21), `@Idempotent()` trả `503`, worker readiness đỏ, enqueue chuyển sang outbox | runbook 14.4, 14.5 |
| Nhóm `scheduler` chết | relay dừng → `outbox_lag_seconds` tăng; job của cron đặt ở `maintenance` (mọi cron tỏa ra/dọn dẹp theo S7-D34) không chạy: lịch vẫn sinh job nhưng không ai consume `maintenance`. Cron nào đặt job ở queue khác (ví dụ `billing` nếu SP5 giữ) vẫn chạy ở `default` | alert `outbox_lag_seconds`, `queue_oldest_job_age_seconds{queue="maintenance"}` |
| Queue không có consumer | values sai bị template chặn (HC-25: phải có nhóm bắt-tất-cả, mọi tên bị loại trừ phải có nhóm khác consume); tên queue lạ fail lúc boot | HC-25, boot |
| Cron tỏa ra gặp lỗi DB | job fail, BullMQ retry; org đã enqueue giữ nguyên | `queue_failed_total` |
| Dòng không giải mã được khi mã hoá lại | bỏ qua, ERROR, counter; không ghi đè | `encrypted_rows_undecryptable_total` |
| Bỏ kid còn đang dùng | đọc dòng đó → `FieldCipherError` (SP2: `get-access-token` 400, notifications lỗi) | runbook 14.7 bước (3)–(4) chặn trước |
| Guard báo sai vì file mode | fail với path cụ thể | `.gitattributes`, Linux CI |
| `upstream:sync` giữa chừng mất điện | trạng thái suy ra từ git (8.2); `--continue` hoặc `git merge --abort` | script in trạng thái |
| CRD catalog hoặc schema Kubernetes tải lỗi trong CI | job `chart` fail (không bỏ qua) | CI |

---

## 18. Observability

- **Metric mới** (không nhãn org, không PII):
  - `example_projects_purged_total` (counter);
  - `encrypted_rows{set, keyring, key}` (gauge);
  - `encrypted_rows_undecryptable_total{set}` (counter);
  - `queue_admin_actions_total{action}` (counter).
- **Log có cấu trúc:** cảnh báo tồn đọng của helper quét cho cron `example.projects.purge-archived` (WARN, tên sự kiện do helper SP6 6.0 chốt), `reencrypt_undecryptable` (ERROR), `reencrypt_batch` (INFO: set, scanned, rewritten, skipped), `queue_admin` (WARN: action, queue, job, ticket, affected, skipped), `migration_lock_busy` (ERROR), `migration_lock_release_failed` (ERROR).
- **Trace:** span auto (http, pg, ioredis, BullMQ). Resource attributes K8s qua `OTEL_RESOURCE_ATTRIBUTES`. `service.name` theo vai trò.
- **`docs/runbooks/alerts.md`:**

  | Metric | Ngưỡng gợi ý | Runbook |
  |---|---|---|
  | `queue_oldest_job_age_seconds` | > 60 s trong 5 phút (queue `notifications`) | 14.4 |
  | `outbox_lag_seconds` | > 30 s trong 5 phút | 14.4 |
  | `outbox_parked_events` | > 0 | 14.4 |
  | tốc độ `queue_failed_total` | > baseline × 3 | 14.4 |
  | tỉ lệ HTTP 5xx | đốt SLO 99,9% nhanh | 14.5 / 14.2 |
  | `encrypted_rows_undecryptable_total` | > 0 | 14.7 |
  | `encrypted_rows{key="unknown"}` | > 0 | 14.7 |
  | alert của SP2/SP3 (`identity_*`, `tenancy_org_purge_failed_total`) | như spec của chúng | README tương ứng |

---

## 19. Test

**Feature mẫu (7D):**

| Mã | Tầng | Nội dung |
|---|---|---|
| EX-U1 | unit | `transition` mọi cặp (2 trạng thái × 5 lệnh) đúng bảng 8.1; kiểm `never` biên dịch |
| EX-U2 | unit | `ProjectName`/`ProjectDescription`: trim, biên 1/100/1000, `""` → `null` |
| EX-U3 | unit | catalogue quyền: key hợp lệ, `requires` đóng, cờ khớp bảng 7.2 |
| EX-U4 | unit | `ExampleFeatures`: hai key, mỗi key một `kind`; `fallback` cờ `true`, quota `UNLIMITED`; `requireEnabled` chỉ nhận key `FLAG` (lỗi kiểu với `example.project_count`); năm `defineEvent` đều khai `audit: true`, `webhook: false` |
| EX-U9 | unit | quét `src/features/example` + `src/migrations/example`: mọi chuỗi `example`/`Example`/`EXAMPLE` thuộc tập định danh 6.3.3 |
| EX-I1 | integration | `app_user` trong `OrgScope(A)`: `SELECT`/`UPDATE`/`DELETE` dòng org B → 0 dòng |
| EX-I2 | integration | `INSERT` với `org_id = B` từ `OrgScope(A)` → `42501` → `404` |
| EX-I3 | integration | không org context → `P0001` |
| EX-I4 | integration | `rls-catalog.spec.ts` xanh với bảng mới qua inventory (RLS + FORCE + policy `TO app_user`, definer read `TO sweep_definer`, grant cột) |
| EX-I5 | integration | `normalization-inventory.spec.ts` xanh với `example.inventory.ts`; bỏ một cột khỏi inventory → đỏ |
| EX-I6 | integration | purge org khi **không** có participant (module fixture) → `23001`; có participant (order 200) → xoá sạch cùng bộ đếm (participant SP4, order 100), `tenancy.org.purged` phát |
| EX-I6b | integration | R7-7 bằng barrier, hai thứ tự: (a) `INSERT` commit giữa participant và `DELETE organizations` → purge rollback, retry xanh; (b) purge đã xoá dòng bộ đếm rồi tạo tiêu quota → một bên nhận `40P01` và được retry; cuối cùng không dòng mồ côi, không bộ đếm lệch |
| EX-I7 | integration | `pg_get_constraintdef` của `name_ck`/`description_ck` chứa đúng hằng; số `1000` trong hàm definer bằng `DEFINER_LIMIT_MAX` của core |
| EX-I8 | integration | hàm definer: trả đúng org có dòng đến hạn, không trả org khác; tham số `NULL`/ngoài biên → lỗi; gọi đúng như runner của SP6 (`p_after => …, p_limit => 1000, p_retention_sec => 2592000`, theo tên) → không `RAISE` (hồi quy của X2-2); `app_user` đọc thẳng bảng không org → `P0001`; `app_owner` trần không `DROP` được hàm (quy tắc SP3); owner của hàm là `sweep_definer` |
| EX-I9 | integration | R7-5 ×50 lặp |
| EX-I10 | integration | R7-6 ×50: bộ đếm = số dòng |
| EX-I11 | integration | R7-8 và R7-18: 20 tạo ∥ 20 xoá tay ∥ job xoá, một phần dùng **cùng** tên khác hoa thường với dòng đang bị xoá; không `40P01` nào xảy ra (đếm qua `pg_stat_database.deadlocks` trước/sau), bộ đếm = số dòng |
| EX-I12 | integration | cron qua helper quét thật và `JobQueue` thật, nhiều hơn một lô (batch nhỏ), worker tạm dừng, hai lượt chồng nhau → mỗi dòng xoá đúng một lần, event `RETENTION` đúng số dòng; job của lượt trước để `failed` thì lượt sau (slot mới) vẫn enqueue được org đó (`jobId` theo slot); runner là `OrgSweepRunner` thật của SP6 và hàm definer thật của mẫu (không mock), lô đầu trả đúng org đến hạn |
| EX-I13 | integration | migration: up → down → up; sweep S2-R57; down khi còn dòng → `RAISE`, DB không đổi; down khi role tuỳ biến giữ quyền → `23503`; down khi đã có dòng `usage_counters` cho `example.project_count` → `23503`, DB không đổi |
| EX-I14 | integration | `EntitlementCatalogueCheck` của SP4 xanh với `ExampleFeatures` + dòng migration; bỏ một dòng `entitlement_features` của mẫu → boot fail |
| EX-I15 | integration | (r2, R-X14) `org-sweep-signatures.spec.ts` của SP6 chạy với `PurgeArchivedSweep` đã đăng ký: hàm `example_orgs_with_purgeable_projects` có đúng một overload, có `p_after uuid`, `p_limit integer`, và `p_retention_sec integer` khớp khoá của `extraParams`; đổi chữ ký trong migration fixture (đảo lại thứ tự r1 vẫn qua vì gọi theo tên; đổi tên `p_retention_sec` → đỏ) |
| EX-E1 | e2e | CRUD đầy đủ bằng cookie; `201` + `Location` + `ETag`; `304`; `204` |
| EX-E2 | e2e | offset, `?status=`, `pageSize` trần, `totalCountExact` |
| EX-E3 | e2e | `Idempotency-Key` replay trả cùng `201`, quota một lần; body khác → `422 idempotency_key_reused`; song song → `409` |
| EX-E4 | e2e | trùng tên (khác hoa thường) → `409 example_project_name_taken`, không lộ tên constraint |
| EX-E5 | e2e | `PATCH` thiếu `If-Match` → `428`; cũ → `412`; `status` trong body → `422`; content-type sai → `415` |
| EX-E6 | e2e | archive/unarchive đúng bảng 8.1, lỗi `409` có mã |
| EX-E7 | e2e | gói fixture `limited` (`example.project_count: { max: N }`): `N + 5` tạo song song → đúng `N` `201`, 5 `422 quota_exceeded` với `errors[0].code = 'example.project_count'`; xoá một → tạo được một; gói dùng `fallback` (`UNLIMITED`) → không giới hạn, bộ đếm vẫn = số dòng |
| EX-E8 | e2e | gói fixture `no-projects` (`example.projects: false`) → `POST`/`PATCH`/archive/unarchive `403 feature_not_in_plan` với `errors[0].code = 'example.projects'`; `GET`/`DELETE` vẫn `200`/`204`; member thiếu quyền trên gói tắt → `403 forbidden` (kiểm gói chạy sau CASL, S4-D7) |
| EX-E9 | e2e | ma trận vai trò × route: OWNER/ADMIN/MEMBER/role tuỳ biến/org key/support grant/không member/org khác → đúng `2xx`/`403`/`404` |
| EX-E10 | e2e | org xoá mềm → mọi route `404`; job xoá của org đó bị gate bỏ qua |
| EX-E11 | e2e | event outbox tới subscriber fixture với version đúng; giết process giữa handler và commit → không event mồ côi |
| EX-S1 | smoke | image thật + compose `--profile app`: tạo → archive → chạy cron (retention nhỏ) → project biến mất |

**Helm chart (7B):**

| Mã | Nội dung |
|---|---|
| HC-1 | mọi pod spec (api, mọi worker, Job) có đủ securityContext §13.3, `automountServiceAccountToken: false`, `enableServiceLinks: false` |
| HC-2 | `/tmp` là `emptyDir`; không `hostPath`, `hostNetwork`, `hostPID` |
| HC-3 | probe đúng path và port theo vai trò; `timeoutSeconds` ≥ 1 |
| HC-4 | `APP_SHUTDOWN_TIMEOUT_MS` ≥ grace × 1000 → `helm template` fail |
| HC-5 | không có `kind: Secret` trong mọi fixture |
| HC-6 | tên secret sinh ra (`DB_APP_PASSWORD`, `REDIS_URL`, `SMTP_PASSWORD`) trong `config`, `api.env` hay `workers.default.env` → `helm lint` fail (schema); tham số không bí mật `AUTH_PASSWORD_MIN_LENGTH`, `AUTH_EMAIL_TOKEN_TTL_SEC`, `AUTH_RESET_TOKEN_TTL_SEC`, `AUTH_EXTERNAL_TOKEN_COOKIE` trong `config` → xanh; khoá do chart đặt (`APP_ROLE`, `WORKER_QUEUES`) trong `config` → fail |
| HC-7 | env secret theo vai trò đúng `files/secret-env.json`: api không có `SMTP_PASSWORD`/`DB_OWNER_PASSWORD`, worker không có `AUTH_GOOGLE_CLIENT_SECRET`, migrate chỉ `DB_OWNER_PASSWORD`; khai vai trò ngoài `roles` → fail; tên không có trong file → fail; `secretEnvExtra` trùng tên boilerplate hoặc trùng khoá config → fail |
| HC-8 | Job migrate: hook annotation (gồm `hook-output-log-policy: hook-failed`), `backoffLimit: 0`, env chỉ gồm tiền tố cho phép + secret vai trò `migrate`, không Redis/khoá; `terminationGracePeriodSeconds` = `ceil(DB_MIGRATION_STATEMENT_TIMEOUT_MS/1000)` |
| HC-9 | NetworkPolicy của Job là hook weight −10, egress DNS + postgres + `extra.migrate`; `podSelector` khớp nhãn pod của Job với cả `nameSuffix` rỗng và `-down-x` |
| HC-10 | `checksum/config` đổi khi config đổi, không đổi khi chỉ đổi image |
| HC-11 | HPA bật → Deployment không có `replicas`; HPA tắt → có |
| HC-12 | PDB mỗi Deployment, `maxUnavailable: 1`, `unhealthyPodEvictionPolicy: AlwaysAllow` (review plan 7B, I3) |
| HC-13 | nhóm `scheduler`: `WORKER_QUEUES=maintenance`, relay bật, dashboard; `default`: `WORKER_QUEUES_EXCLUDE=maintenance`, relay tắt |
| HC-14 | tên nhóm worker sai → fail; tên đối tượng > 63 → fail |
| HC-15 | `networkPolicy.enabled` mà `apiIngressFrom` rỗng → fail |
| HC-16 | rule internet loại trừ đủ dải (so với hằng); cổng = `RESILIENCE_ALLOWED_PORTS` của vai trò (`workers.default.env` đè `config` → cổng khác nhau theo vai trò); `internet.enabled` mà không đặt `RESILIENCE_ALLOWED_PORTS` → fail |
| HC-17 | `OTEL_ENABLED=true` khi `otel.enabled`; `OTEL_RESOURCE_ATTRIBUTES` tham chiếu biến downward đã khai trước; `endpointFromHostIP` dùng `$(HOST_IP)`; Job migrate không có `OTEL_*` |
| HC-18 | `httpRoute` và `ingress` cùng bật → fail |
| HC-19 | budget connection vượt → fail với thông điệp; thiếu `DB_POOL_MAX` khi bật → fail |
| HC-20 | `image.digest` có → image `repo@sha256:…`; không digest không tag → fail |
| HC-21 | `helm lint --strict` xanh với 4 fixture trên Helm 4.3.0 và 3.22.0 |
| HC-22 | kubeconform xanh trên 1.34.12 và 1.37.1 (gồm HTTPRoute, policy Kyverno) |
| HC-23 | Dashboard Service không bao giờ được HTTPRoute/Ingress trỏ tới |
| HC-24 | nhãn chuẩn và selector không đổi giữa hai lần render khác image (selector bất biến) |
| HC-25 | độ phủ queue (12.1): không nhóm bắt-tất-cả → fail; `queuesExclude: [x]` mà không nhóm nào khác consume `x` → fail; nhóm `hot` có `queues: [notifications]` mà `default` không loại trừ `notifications` → fail; values mặc định và `ci/values-split-workers.yaml` xanh |
| HC-26 | nhóm egress: `objectStorage` có ở api và mọi worker, `clamd` chỉ ở worker, `idp` ở api và nhóm có dashboard; `extra.api`/`extra.worker`/`extra.migrate` chép nguyên vào đúng policy; rule sai hình dạng → schema fail |
| HC-27 | `otel.enabled` mà `egress.otel` rỗng → fail (cả khi `endpointFromHostIP`) |
| HC-28 | `dashboard.ingressFrom` khác rỗng mà `ipAllowlist` = `127.0.0.1/32` → fail |
| HC-29 | `migrate.enabled` mà thiếu `config.DB_MIGRATION_STATEMENT_TIMEOUT_MS` → fail; `activeDeadlineSeconds ≤ G` → fail; `NOTES.txt` in `T_min = D + G + 60` đúng số |
| HC-30 | `pnpm chart:secrets --check` xanh; đánh dấu thêm một trường `secret` trong fixture config → `--check` đỏ; `values.schema.json` và `files/secret-env.json` sinh lại giống hệt byte (định dạng ổn định) |
| HC-31 | (Review plan 7B) `dbPoolGuard`: nhóm worker consume `webhooks-out` thiếu `DB_POOL_MAX` hoặc concurrency tường minh → fail; `DB_POOL_MAX` < concurrency + headroom → fail với phép tính; nhóm đã loại trừ queue thì không bị đòi; `enabled: false` bỏ kiểm |
| HC-32 | (Review plan 7B, I5, I7, M8) except-list internet đủ dải mới + `exceptExtra`; `smtp.internet.ports` sinh rule internet riêng chỉ ở worker, không đổi cổng của `RESILIENCE_ALLOWED_PORTS`; `OTEL_EXPORTER_OTLP_HEADERS` trong `config` → schema fail |
| HC-33 | (Review plan 7B, I1) Job migrate tên `…-migrate<suffix>-r<revision>`, có `ttlSecondsAfterFinished`; tên ≤ 63 kể cả hậu tố revision |

Kind smoke (chạy thật; `smoke.sh` chỉ dùng route vùng boilerplate, bước mẫu có điều kiện):
- HC-K1: cài lần đầu vào namespace PSA `restricted` và default-deny → pod đủ, Job migrate `Complete`.
- HC-K2: `/health/ready` 200 qua port-forward; smoke HTTP đăng ký → xác thực email (thư lấy từ API Mailpit) → tạo org. Nếu `src/features/example` tồn tại: thêm tạo project.
- HC-K3: upgrade đổi config → pod lăn, không có lúc 0 pod Ready.
- HC-K4: upgrade với migration hỏng (fixture) → release `failed`, pod cũ nguyên, Job giữ log, output của `helm upgrade` chứa log Job.
- HC-K5: `helm rollback` → revision cũ chạy.
- HC-K6: pod thử bị chặn tới `169.254.169.254` và tới Redis khi thiếu rule (T7-3).
- HC-K7: SIGTERM api trong khi có request dài → request xong, không `502` trong drain.
- HC-K8: `kubectl exec … queue-admin.js stats` (không `-t`) chạy được trong pod distroless.
- HC-K9 (C2): upgrade sang values có `SMTP_USER` trong `config` (Mailpit bật AUTH), `AUTH_GOOGLE_CLIENT_ID` trong `config`, `AUTH_MODE=hybrid` với discovery trỏ mock-oauth2-server trong cụm (qua nhóm egress `idp`), Secret test chứa **mọi** secret nhưng chart chỉ phát theo `files/secret-env.json` → api và mọi nhóm worker `Ready`; thư xác thực tới Mailpit qua SMTP AUTH (chứng minh worker có `SMTP_PASSWORD`, api không cần); `env` của pod api không có `SMTP_PASSWORD`, của worker không có `AUTH_GOOGLE_CLIENT_SECRET`/`AUTH_OIDC_CLIENT_SECRET`.
- HC-K10 (review plan 7B, I1, R7-19): upgrade làm Job migrate treo (fixture bỏ egress `postgres` của Job: SYN bị NetworkPolicy thả) với `--timeout` ngắn → Helm 4.3 báo fail, Job `-r<N>` vẫn `active` (không bị xoá); làm đúng bước 8 của runbook 14.1 (phiên `saas-migrator-lock` = 0 → xoá Job treo) rồi chạy lại upgrade → release `deployed`, Job `-r<N+1>` `Complete`.

**Core (7B, 7C, 7E):**

| Mã | Nội dung |
|---|---|
| CO-1 | `WORKER_QUEUES_EXCLUDE`: loại trừ đúng; cùng `WORKER_QUEUES` → boot fail; tên lạ → fail; tập rỗng → fail |
| CO-2 | hai `runMigrations('up')` song song → một exit 1 "migration lock", một xanh; khoá được nhả khi lỗi; `pg_locks` không còn khoá advisory sau khi process kết thúc ở cả nhánh xanh lẫn nhánh lỗi |
| CO-2b | migration fixture giữ lượt (seam barrier của test, review plan 7B) lâu hơn idle timeout của pool MikroORM; giữa lượt, migrator thứ hai thử → vẫn bị từ chối; khoá nằm trên phiên `saas-migrator-lock`, khác phiên chạy migration; sau lượt, khoá nhả |
| CO-2c | (Review plan 7B, I2) giữa lượt (seam barrier), `pg_terminate_backend` phiên khoá → lượt chạy ném `MigrationLockLostError` có tên, log `migration_lock_session_lost`; backend của pool ORM biến mất trong hạn (poll); không migration nào được ghi |
| CO-3 | `main.migrate.js up` với **chỉ** env của Job (HC-8), `NODE_ENV=production` và `DB_SSL_MODE=verify-full` (Testcontainers Postgres có TLS như test SP1) chạy xanh trên image thật |
| CO-4 | ma trận validate config (child process, `validateAllConfigs()` sau khi nạp composition như `main.*`): vai trò ∈ {api, worker, migrate} × {SMTP AUTH bật/tắt} × {Google bật/tắt} × `AUTH_MODE` ∈ {`local`, `hybrid`, `external`} × `NODE_ENV` ∈ {`development`, `production`} × module SP5/SP6 khi đã merge. Env = config của ô ma trận + **chỉ** secret mà `secretFieldsOf` cho vai trò đó → mọi ô xanh; thêm một ô bỏ một secret của vai trò → đỏ với đúng tên env. Test này là bằng chứng luật config và allowlist chart khớp nhau |
| QA-1 | lệnh ghi không TTY → exit 1; thiếu `--ticket` ở lệnh ghi → exit 1; gõ sai tên queue → không đổi gì; `stats` không TTY → chạy xanh |
| QA-2 | `pause` → worker không lấy job mới; `resume` → lấy lại |
| QA-3 | log WARN đủ trường (`affected`, `skipped`), không payload job |
| QA-4 | queue có 30 job `failed` tên X và 30 tên Y xen kẽ: `retry-failed --job X --max 10` chuyển đúng 10 job X sang `wait`, log `affected: 10`; không job Y nào đổi; một job X bị dọn giữa lúc chụp và retry → `skipped: 1` |
| QA-5 | `retry-failed` không `--job`/`--max` → gọi `retryJobs`, log `affected: null`, mọi job `failed` của queue sang `wait` |

**Xoay khoá (7C):**
- KR-1: thêm kid, đổi active → cron ghi lại mọi `auth.account` token.
- KR-2: gauge đúng theo kid và `unknown`.
- KR-3: `EXPIRE` chỉ đếm, không ghi.
- KR-4: R7-10 bằng barrier.
- KR-5: R7-11.
- KR-6: dòng hỏng → `undecryptable`, dòng khác vẫn xử lý.
- KR-7: bỏ kid sau khi gauge về 0 → `get-access-token` 200.
- KR-8: registry: key trùng hoặc provider sai interface → boot fail.
- KR-14: keyring một kid → cron chỉ đếm, không chạy câu chọn dòng ghi lại (đếm câu SQL qua log pg); `EXPLAIN (ANALYZE, BUFFERS)` của câu đếm trên seed 10× ghi vào plan 7C.
- KR-9…KR-13 (T7-1):
  - legacy bare-hex giải mã được;
  - đăng nhập lại rồi `verify-totp` 200;
  - JWT ký và verify;
  - cron chuyển mọi dòng sang envelope hiện tại;
  - bỏ legacy và version cũ → 2FA vẫn chạy; cookie và bearer cũ → 401.

**Upstream (7A):**

| Mã | Nội dung |
|---|---|
| UP-1 | repo tạm: clone ở tag, sửa `src/core/x.ts` → check fail nêu đúng path |
| UP-2 | xoá file boilerplate → fail |
| UP-3 | xoá vùng template → pass; sửa một file template còn lại → fail; tạo file mới trong vùng template → fail |
| UP-4 | `package.json`: đổi version dep upstream → fail; thêm dep → pass; script mới không tiền tố `app:` → fail |
| UP-5 | sửa `zones.json` ở `HEAD` để nới → vẫn fail (đọc từ commit upstream); sửa `tools/upstream/check.mjs` ở `HEAD` cho luôn exit 0 → workflow vẫn fail (chạy bản của commit upstream) |
| UP-6 | sync rồi squash → `version.json.commit` không phải tổ tiên → fail |
| UP-6b | sau UP-6: `git merge -s ours --no-ff <tag>` trên nhánh mới → cây không đổi (`git diff` rỗng), check xanh |
| UP-7 | `sync` tự giải: boilerplate theirs, template đã xoá giữ xoá, lockfile/env/openapi sinh lại; `package.json.version` của dự án không bị đụng |
| UP-8 | `sync` dừng ở `MERGING_MANUAL` với file dự án xung đột; `--continue` hoàn tất |
| UP-9 | `check --self` trên repo upstream: mọi file track được phân vùng tường minh; thêm file không vùng → fail; track một file vùng dự án ngoài `projectSeed` (ví dụ `src/app.plans.ts`, `src/migrations/app/x.ts`) → fail |
| UP-10 | job "upgrade path": migrate bản cũ → bản mới xanh, với migration upstream timestamp cũ hơn migration app |
| UP-11 | R7-16 |
| UP-12 | `composeAppModules`: `disable: ['notifications']` khi identity bật → ném; khoá trùng/lạ → ném; `entitlements` bật mà thiếu `plans` → ném; mục `OPTIONAL_BRIDGES` có `when` chứa khoá lạ → ném |
| UP-12d | (r2, R-X13) `composeFrom` với cầu nối fixture `when: ['fixturemod', 'notifications']`: cả hai bật → module của cầu nối có trong api **và** worker, đứng sau module nền; một trong hai tắt → cầu nối không được `import()` (spy trên loader), không có trong kết quả. Sau khi 4B merge: composition thật với `entitlements` + `files` có `EntitlementsFilesPortsModule` ở cả hai vai trò; tắt `files` → không có (ca này là ST-2/ST-4 của SP4, chạy trên `OPTIONAL_BRIDGES` thật) |
| UP-12b | (C1) child process, Testcontainers: tắt một module có queue, cron và env bắt buộc (7A: module fixture `fixturemod` qua `composeFrom(entries, opts)`, hàm mà `composeAppModules` gọi với `BOILERPLATE_MODULES`, export cho test; từ SP5/SP6: thêm ca `billing`, `files` thật) → env bắt buộc của nó vắng mà validate xanh; worker boot (không lỗi `Jobs on consumed queues have no @JobHandler`); `queueRegistry()`/`cronRegistry()`/`configRegistry()` không có mục nào của nó; `gen-env-example` không có dòng nào của nó; Redis đã có `static-<m>.*` từ một lần chạy bật → bị gỡ; luật chéo module của nó không đăng ký |
| UP-12c | (C1) nạp riêng từng mục `BOILERPLATE_MODULES` trong child process: mọi cron nó đăng ký có tiền tố `<m>.`; feature fixture import tĩnh index của module bị tắt → `composeAppModules` ném đúng thông điệp nêu tên module |
| UP-13 | (I5) trên một cây đã chạy `upstream:init` (vùng template đã xoá): chạy các job CI của boilerplate (`ci.yml` gồm `kind-smoke` trên hằng đêm) → xanh, không cần sửa file boilerplate nào |

**Runbook (7E):** RB-1 quét `docs/runbooks/*.md` và kiểm các token trong backtick:
- lệnh `helm upgrade`/`helm rollback` chỉ dùng cờ trong danh sách cho phép (`--install`, `-n`, `-f`, `--set`, `--wait`, `--timeout`, `--rollback-on-failure`, `--cleanup-on-fail`); `--atomic`/`--force` → fail;
- token dạng `UPPER_SNAKE` phải có trong `.env.example` hoặc allowlist Kubernetes/Helm;
- tên metric phải có trong registry metric (quét `createCounter`/`createObservableGauge`/… trong `src`);
- `pnpm <script>` phải có trong `package.json`;
- path `dist/…js` phải có file nguồn tương ứng.

---

## 20. Chia plan

Mỗi plan xanh pipeline đầy đủ (lint, type-check, unit, integration, migration up → down → up + sweep, `oasdiff`, kiến trúc, prod-like) trước khi merge. Phụ thuộc dưới là phụ thuộc **thật** theo từng plan (per R-X7); thứ tự toàn cục W1…W8 của R-X7 đặt 7A ở W2, 7B ở W3, 7C ở W4, 7D ở W5, 7E ở W8.

```
3A ──► 7A Upstream + composition ──► 7B Helm + core deploy ──► 7C Xoay khoá ──┐
         │                                                                     ├──► 7E Runbook + queue-admin
         └──► 7D Feature mẫu (+ 4B, 3D, 6.0) ◄── 7A                             │    (+ 3D, 5C, 6D)
                                                         7B ───────────────────┘
```

| Plan | Wave (R-X7) | Phụ thuộc thật | Lý do phụ thuộc | Nội dung | Test |
|---|---|---|---|---|---|
| **7A Upstream + composition** | W2 | 3A | Composition phải gồm `TenancyModule` mà 3A thêm vào `app.modules.ts`; `markModuleLoaded` thêm vào index của tenancy | `boilerplate.modules.ts` (loader lười, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES` rỗng, R-X13) + `composeAppModules`/`composeFrom`; `loadedModules()` export ở `core/config` (R-X13, R-X16); `composition.config.ts` theo tập module bật; `markModuleLoaded`; gỡ cron của module bị tắt; `gen-env-example` theo composition; chuyển README (gồm "Tắt module", quy ước cron S7-D34); `zones.json` (`projectSeed`), `tools/upstream/*` (check chạy từ commit upstream), `upstream-guard.yml`, job upgrade path; release-please `simple` + CHANGELOG khởi đầu `v0.1.0`; `docs/upstream/*` (squash: phòng, phát hiện, khôi phục); `.dependency-cruiser.app.cjs` hook; mở rộng `normalization-inventory` bằng glob; ADR 0002 cập nhật. Cặp 7A ∥ 4A: plan merge sau chuyển/đặt mục `entitlements` (amendment D1). Dòng `entitlements-files` của `OPTIONAL_BRIDGES` **không** thuộc 7A: SP4 4B thêm (W4 > W2) | UP-1…UP-12d |
| **7B Helm + core deploy** | W3 | 7A | Chart đọc composition và script sinh secret nạp `BOILERPLATE_MODULES` | Chart, values, schema, fixtures; metadata `secret` + `chart:secrets` + `files/secret-env.json`; luật config theo vai trò (C2: database, notifications, identity); `deploy/tools.env`; job `chart`, `kind-smoke` (Mailpit AUTH, mock-oauth2-server, chỉ route boilerplate); `test/deploy`; `WORKER_QUEUES_EXCLUDE`; migrate config tối thiểu; khoá advisory trên `pg.Client`; kiểm độ phủ queue; nhóm egress; policy Kyverno mẫu; spike T7-2, T7-3, T7-4; ADR 0021; ghi kích thước image vào ADR 0013 (không đổi) | HC-1…HC-33, HC-K1…HC-K7, HC-K9, HC-K10, CO-1…CO-4 (gồm CO-2c), UP-13 (phần không cần 7E) |
| **7C Xoay khoá** | W4 | 7B | Cron `core.security.reencrypt` chạy ở nhóm `scheduler`; `AUTH_SECRETS` vào danh sách secret sinh ra | Registry `EncryptedFieldSet`, cron (mỗi giờ, bỏ quét ghi lại khi một kid), metric; ba tập; spike T7-1 → `AUTH_SECRETS` (nhánh A) hoặc ghi ADR (nhánh B); ADR 0010 cập nhật | KR-1…KR-14 |
| **7D Feature mẫu** | W5 | 7A, 4B, 3D, 6.0 | 7A: composition + vùng template; 4B: `Quotas` (`consumeOrThrow`, `releaseAllocation`, bảng `usage_counters`), 4A đi kèm (`defineFeatureCatalogue`, `requireEnabled`, `entitlement_features`); 3D: org API key và support grant cho EX-E9, registry order (addendum 3D §A4, `order < 1000`); 6.0: `sweep_definer`, `defineOrgSweep` theo R-X14 (`extraParams` theo tên), `org-sweep-signatures.spec.ts`, `DEFINER_LIMIT_MAX` ở core, cờ event bắt buộc | Mọi thứ mục 6.3, 7–11.1; `src/plans.example.ts` vào vùng template (nội dung SP4); luật depcruise features; `rls-catalog` nạp inventory; spike T7-5; `EXPLAIN` bốn câu | EX-* |
| **7E Runbook + queue-admin** | W8 | 7B, 7C, 3D, 5C, 6D | 3D: runbook reset 2FA; 5C, 6D: runbook và alert phủ billing, audit, partition, phê duyệt | `queue-admin` CLI (API BullMQ 6.3.8 thật); bảy runbook + `alerts.md` với lệnh Helm 4.3 đã chốt; RB-1; HC-K8; kind smoke chạy lệnh runbook; lệnh PgBouncer và quy trình JWKS khẩn cấp đọc từ bản pin | QA-1…QA-5, RB-1, HC-K8 |

- **Rủi ro lịch** (SP3 r8 T7(h)): nếu 3D phải dừng vì một điểm hook không đạt, 7D và 7E dừng theo; 7A, 7B, 7C không phụ thuộc 3D và tiếp tục.
- 7D **không** phụ thuộc 6A/6C: mẫu không dùng file hay webhook (event `webhook: false`).

**Race → plan:**

| Plan | Race |
|---|---|
| 7A | R7-16, R7-17 |
| 7B | R7-12, R7-13, R7-14, R7-19, R7-20 |
| 7C | R7-10, R7-11 |
| 7D | R7-1 … R7-9, R7-18 |
| 7E | R7-15 |

**Tiêu chí mục 1 → plan:**

| Plan | Tiêu chí |
|---|---|
| 7A | 6 (gồm tắt module), 7 |
| 7B | 3, 4, 5 |
| 7C | 9 |
| 7D | 1, 2 |
| 7E | 8 |
| mọi plan | 10 |

---

## 21. Sửa spec cha và spec SP trước

| # | Tài liệu | Chỗ | Sửa |
|---|---|---|---|
| A1 | Spec cha §1.1 | vùng sở hữu | thay bằng bảng 6.1 (thêm vùng template, sinh ra, chung; `projectSeed`); CI dùng so cây với commit upstream ghi trong `.upstream/version.json`, chạy bộ kiểm của commit upstream; README chuyển sang `docs/boilerplate/`; composition `boilerplate.modules.ts` + `composeAppModules` nạp module lười ("bỏ module" = không import, S7-D7) |
| A2 | Spec cha §13.1 | K8s | "Helm chart tối giản" → mục 12: nhóm worker `scheduler`/`default` (`WORKER_QUEUES_EXCLUDE`, kiểm độ phủ queue); Job hook `pre-install,pre-upgrade` env nhúng; allowlist secret sinh từ code; NetworkPolicy có nhóm egress và `extra`; OTLP, không ServiceMonitor; HTTPRoute/Ingress tuỳ chọn; policy Kyverno mẫu ở `deploy/policy/` cho dòng "xác minh chữ ký image… (sub-project 7)" |
| A3 | Spec cha §15.1 | cây thư mục | `features/example/` = "CRUD theo org, state machine, 1 cron tỏa ra theo org, 1 job theo org, 1 quota"; thêm `src/migrations/example/`, `src/boilerplate.modules.ts`, `tools/upstream/`, `deploy/helm/saas-app/`, `deploy/values/`, `deploy/policy/`, `docs/runbooks/`, `docs/upstream/`, `docs/boilerplate/`; `docker-compose.yml` → `compose.yaml` (tên thật) |
| A4 | Spec cha §3.3 | Controller dùng `CommandBus` | "bắt buộc với module nền; feature được gọi service trực tiếp" (S7-D3) |
| A5 | Spec cha §6 | queue mặc định, cron | thêm `example` (vùng template); `WORKER_QUEUES_EXCLUDE`; quy ước cron S7-D34 (job tỏa ra/dọn dẹp ở `maintenance`, việc theo org ở queue của module) |
| A6 | Spec cha §11 | FieldCipher | "job/runbook mã hoá lại hoãn SP7" → registry `EncryptedFieldSet` + cron `core.security.reencrypt` (mỗi giờ) + runbook 14.7; Better Auth `AUTH_SECRETS` (nếu T7-1 đạt) |
| A7 | Spec cha §15 | ADR | thêm 0021 "Deploy Kubernetes bằng Helm" (số theo R-X6) |
| A8 | Spec cha §4 Migration | "Mỗi module một thư mục, riêng dự án dùng `src/migrations/app/`" | thêm: migration upstream có thể chạy sau migration dự án có timestamp mới hơn (MikroORM chạy mọi migration chưa chạy); migration dự án không `ALTER`/`DROP` đối tượng boilerplate, chỉ chèn dòng catalogue/seed (S7-D31); migration của module bị tắt vẫn chạy; runner giữ khoá advisory trên client riêng |
| A9 | Spec cha §12 (config, secret) | secret | secret khai bằng metadata `secret: { roles }` trên schema config; luật config đòi secret nào thì chỉ đòi ở vai trò nhận secret đó (S7-D33, C2) |
| B1 | SP3 §6.13 | `migration-order.spec.ts` | luật "timestamp lớn hơn migration mới nhất của `main`" áp **trong từng vùng** (boilerplate+template so với nhau; `app/` so với nhau), không so chéo (S7-D31) |
| B2 | SP3 §18.1, §5.3 | `rls-catalog.spec.ts` hằng `GLOBAL_TABLES`, `DEFINER_FUNCTIONS_*`, `DEFINER_READ_TABLES_*` | gộp thêm khai báo từ `test/**/features/**/*.inventory.ts` (S7-D28) |
| B3 | SP3 §7.1/§7.4 | inventory route lúc boot | thêm kiểm trùng `(method, template đã chuẩn hoá)` trên **mọi** handler (không chỉ route tenant): trùng → không khởi động |
| B4 | SP3 §9.5 | "vận hành retry trên Bull Board" | Bull Board read-only (SP2) → `pnpm queue:admin retry-failed` (S7-D23) |
| B5 | SP3 §22.1 README | vị trí | README boilerplate ở `docs/boilerplate/README.md`. Quy ước `order` participant **không** do SP7 đặt nữa: dùng registry order ở addendum 3D §A4 (per R-X5, R-X12; mẫu = 200; feature của dự án chọn số chưa dùng trong 201–999). Đề xuất "feature ≥ 1000" của r0 bỏ, vì tenancy core giữ 1000 và phải chạy cuối, và registry nay từ chối `order ≥ 1000` |
| B6 | SP3 §5.2 hàng lệnh reset | môi trường | runbook Kubernetes (`kubectl exec -it`, không `--password-file`) ở `docs/runbooks/staff-2fa-reset.md` |
| C1 | SP2 README "CLI và runbook" | xoay `BETTER_AUTH_SECRET`, FieldCipher | trỏ sang `docs/runbooks/key-rotation.md` |
| C2 | SP2 §5.15 | `gen-env-example` | nạp từ `app.modules.ts` |
| C3 | SP2 (code core + identity + notifications, 7B) | luật config không biết vai trò | các sửa C2 của mục 6.5: `appPassword` optional + luật api/worker; `database-query-deadline` bỏ qua migrate; `smtp-auth-pair` chỉ worker; cặp Google và `AUTH_OIDC_CLIENT_SECRET` chỉ api; Better Auth ở worker không dựng Google/`genericOAuth`; `assertAuthProvidersRegistered` chỉ kỳ vọng OIDC ở api. Hành vi api không đổi; worker/migrate bớt yêu cầu |
| D1 | SP4 r1 | API và composition | mẫu dùng đúng API công khai SP4 §6.4 (mục 10.4); participant purge SP4 order 100 xoá bộ đếm; `quota_exceeded`/`feature_not_in_plan` là mã chung. Composition: `EntitlementsModule.forApi(plans)`/`forWorker(plans)` nhận catalogue gói qua `composeAppModules({ plans })` (X-7), không qua `APP_MODULES` viết tay; plan merge sau trong cặp 7A ∥ 4A thêm mục `entitlements` vào `BOILERPLATE_MODULES` và `entitlements → tenancy` vào `MODULE_REQUIRES`; index của entitlements gọi `markModuleLoaded('entitlements')`. (r2, R-X13) SP4 4B thêm dòng `entitlements-files` vào `OPTIONAL_BRIDGES` (adapter `FileStorageLimit` ở `modules/entitlements/integrations/files.ts`) cùng kiểm lúc boot của files; 7A chỉ tạo hằng rỗng. (r2, R-X19) SP4 export lớp lỗi có tên; mẫu không bắt lỗi nào của SP4 ngoài `AppError` đi qua problem của core. Catalogue gói khởi đầu ship ở vùng template `src/plans.example.ts`, migration seed gói ở `src/migrations/example/…_starter_plans` (S7-D36, X-6), không ở `src/app.plans.ts`/`src/migrations/app/`; bỏ luật "migration `app/` mới nhất > mọi migration module" (S7-D31) |
| D2 | SP4, SP5, SP6 (r2: nhận ở spec của từng SP, per R-X16) | secret, luật config, egress, runbook | mỗi SP: (0) `markModuleLoaded('<m>')` ở dòng đầu `index.ts` và dòng `MODULE_REQUIRES` của mình (SP4 `entitlements → tenancy`; SP5 `billing → …` theo spec SP5; SP6 `files`/`integrations → tenancy`, `audit → identity, tenancy`, `admin → audit, identity, tenancy`, admin đọc số liệu files/integrations qua token ở `core/contracts` nên không phụ thuộc hai module đó); (1) đánh dấu `.meta({ secret: { roles } })` trên trường secret của mình (SP4: không có trường secret; SP5 `BILLING_SEPAY_WEBHOOK_SECRET` roles `['api']` và luật đòi nó chỉ ở api; SP6 `FILES_S3_SECRET_ACCESS_KEY`, `FILES_S3_ACCESS_KEY_ID` roles `['api','worker']`), chạy `pnpm chart:secrets`; (2) luật config đòi secret theo vai trò (mẫu C3); (3) SP6 ghi đường egress cần mở vào README/values mẫu qua nhóm `objectStorage`, `clamd` và `extra` (12.6); (4) dòng xoay khoá vào 14.7; (5) tập `EncryptedFieldSet` nếu có cột mã hoá; (6) index module gọi `markModuleLoaded`, cron có tiền tố `<module>.`; (7) cron tỏa ra theo quy ước S7-D34 (SP5 `billing.sweep`/`billing.reminders` hiện ở queue `billing`: SP5 chọn theo quy ước hoặc ghi lý do); (8) concurrency riêng của queue qua `QUEUE_CONCURRENCY_OVERRIDES` trong values mẫu (`files`, `webhooks-out`, `billing`) |
| D3 | SP6 plan 6.0 (per R-X3, R-X4, R-X14) | core dùng chung | mẫu cần: `defineEvent` với `audit`/`webhook` bắt buộc; role `sweep_definer` trong `01-roles.sh`; `DEFINER_LIMIT_MAX` export từ core; helper `defineOrgSweep` **đúng như SP6 r2 §5.3** (r2 bỏ yêu cầu callback `(cursor, limit)` của r1): tên hàm SQL chữ ký `(p_after uuid, p_limit integer, …)`, `extraParams` theo tên, khoá cron, lịch, cỡ lô, số lô tối đa, job theo org, tiền tố `jobId`, `jobId` theo slot. Mẫu đổi phía mình (mục 7.3, 10.2), SP6 không đổi gì cho mẫu |
| E1 | ADR 0002 | "Chưa quyết, xem sub-project 7" | quy trình 13.2–13.6, S7-D8, S7-D9, S7-D36 |
| E2 | ADR 0006 | worker | nhóm worker, `WORKER_QUEUES_EXCLUDE`, quy ước cron S7-D34, `queue-admin` |
| E3 | ADR 0010 | secret Better Auth | T7-1 và kết quả |
| E4 | ADR 0021 (mới, per R-X6) | deploy Kubernetes bằng Helm | S7-D11…S7-D20, S7-D30, S7-D32, S7-D33 |

---

## 22. Rủi ro còn mở

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| O-1 | (r2, thu hẹp) Code của SP4 4B hoặc SP6 6.0 lệch spec r2 ở tên/chữ ký mà mục 10.2, 10.4 dùng. Phần helper đã đóng ở spec: chữ ký theo R-X14 và mẫu đã đổi phía mình | 7D bắt đầu sau 4B và 6.0; bước đầu 7D đối chiếu mục 10.2, 10.4 với code đã merge; `org-sweep-signatures.spec.ts` (EX-I15) bắt lệch chữ ký hàm definer; chỉ đổi lời gọi, không tự viết cơ chế thay thế; bảo đảm của 10.4 không đạt thì dừng và báo |
| O-2 | (đóng ở r1) Cờ Helm 4.3 đã đọc từ `pkg/cmd` ở tag (review ops) | Lệnh runbook 14.1/14.2 viết tường minh; kind smoke chạy đúng lệnh; RB-1 cấm `--atomic`/`--force` |
| O-3 | kindnet không thực thi NetworkPolicy | T7-3 fallback cài Calico pin |
| O-4 | Luật config của `database` đọc namespace khác, làm migrate tối thiểu fail | Đã xác định ở r1: chỉ `database-query-deadline` (production, cần `http`); sửa cho biết vai trò (mục 6.5); CO-3 chạy với `NODE_ENV=production` |
| O-14 | Top-level await trong `app.modules.ts` (C1): một công cụ import `app.modules.ts` theo kiểu CommonJS sẽ không chạy | Mọi entry là ESM (`"type": "module"`, SWC `es2022`, Vitest ESM); `gen-env-example`, `export-openapi` là ESM. UP-12b chạy qua `dist/` thật |
| O-15 | Module SP sau quên `markModuleLoaded` hoặc đặt cron khác tiền tố module | UP-12c chạy trên mọi mục `BOILERPLATE_MODULES`: thiếu `markModuleLoaded` hoặc cron sai tiền tố → đỏ. (r2) SP4, SP5, SP6 đã ghi nghĩa vụ này trong spec của mình (R-X16) |
| O-17 | (r2) Cầu nối tuỳ chọn bị gỡ khỏi `OPTIONAL_BRIDGES` hoặc không nạp được trong khi hai module của nó bật | Module chủ port tự kiểm lúc boot bằng `loadedModules()` (SP6 `FileStorageLimitCheck`, R-X13): không khởi động; SP4 ST-4 |
| O-18 | (R-X36) Rollback app xuống dưới ranh giới expand/contract chỉ được chặn bằng runbook (14.2) | Follow-up 7E: bảng core `schema_compat(min_code_version)` do migration cần nó ghi, kiểm lúc boot từ chối code cũ hơn; phủ `helm rollback`, đổi image tay, migrate tay |
| O-16 | Tên file version mặc định của strategy `simple` của release-please (giả định `version.txt`) | 7A đọc lại từ source release-please mà action v5.0.0 kèm trước khi viết config |
| O-5 | Better Auth `secrets`: bearer và cookie cũ mất hiệu lực là hành vi của thư viện, có thể đổi ở bản sau | T7-1 thành test hồi quy; Renovate nhóm better-auth chạy lại |
| O-6 | Guard so cây quá chặt khi cần vá gấp | S7-D9: bản vá upstream nhanh (release-please patch); runbook upstream có mục "bản vá khẩn" |
| O-7 | Thứ tự migration khác nhau giữa DB mới (CI) và production | quy tắc dự án không chạm đối tượng boilerplate; job upgrade path chạy đúng thứ tự production |
| O-8 | Xung đột modify/delete ở vùng template mỗi lần upstream sửa mẫu | `sync` tự giải (giữ đã xoá) |
| O-9 | Tài nguyên mặc định chưa đo | kind smoke chỉ chứng minh chạy được; dự án đo trên staging bằng k6 (§14) và chỉnh values |
| O-10 | `OTEL_RESOURCE_ATTRIBUTES` không được đọc | T7-4 fallback thêm detector tường minh |
| O-11 | Semver do người đánh giá; export công khai đổi mà không báo major | mục "Upgrade notes" bắt buộc trong PR; có thể thêm api-extractor sau nếu lặp lại |
| O-12 | Recursive "loose index scan" nếu T7-5 chậm | fallback đã ghi |
| O-13 | Dự án dùng CNI hay gateway lạ (không Gateway API, không Ingress) | cả hai template tuỳ chọn; dự án tự thêm route ở chart con, hoặc đề xuất upstream |

**Điểm mở rộng (không làm ở SP7):**
- `pnpm feature:new` (generator từ mẫu);
- publish chart OCI;
- `PrometheusRule` khi có dự án dùng Prometheus Operator;
- KEDA;
- Argo Rollouts canary;
- api-extractor cho export công khai;
- chart con cho PgBouncer.

---

## 23. Cần Sếp quyết

Không có. SP7 không có lựa chọn nào mang hệ quả pháp lý hay tiền mà thiếu nguồn: công cụ đều mã nguồn mở, phát hành trên GitHub có sẵn, không dịch vụ trả phí mới.

---

## 24. Tự review

- **Placeholder:** không có "TBD"/"TODO". Có những chỗ **cố ý** chốt ở plan kèm cách chốt:
  - lệnh admin PgBouncer 1.25.2 và quy trình JWKS khẩn cấp: 7E đọc tài liệu và code của bản pin;
  - (r2) tên hàm/chữ ký của helper quét đã chốt theo SP6 r2 (R-X14) và API SP4 theo SP4 r2; 7D chỉ còn đối chiếu với code đã merge (O-1 thu hẹp);
  - tên file version của release-please `simple` (O-16).
  - Giá trị `<owner>/<repo>` trong policy Kyverno là tham số của dự án, không phải placeholder chưa quyết.
- **Tự phá thiết kế r1 (điểm yếu nhất và cách kiểm):**
  - **Composition lười (C1)** giả định mọi đăng ký toàn cục chỉ xảy ra qua import index của module. Một module import tĩnh index của module khác mà không khai `MODULE_REQUIRES` sẽ kéo module kia vào dù bị tắt. Cách kiểm: bước 4 của `composeAppModules` (`markModuleLoaded`) làm boot fail có tên module; UP-12b/12c chạy trên mọi mục.
  - **Allowlist sinh từ code (C2, I1)** chỉ đúng nếu mọi trường secret được đánh dấu. Trường secret mới quên `.meta` sẽ lọt vào ConfigMap được. Cách kiểm: CO-4 fail ở vai trò cần secret đó (vì chart không phát nó); review PR có mục "trường secret mới đã có metadata" trong template PR.
  - **Thứ tự "insert rồi consume" (S7-D35)** đổi thứ tự lỗi (`409` trước `422`) và làm một `INSERT` thừa khi hết quota; chấp nhận vì đổi lại mất chu trình khoá thật (R7-18). EX-I11 đếm `deadlocks` của `pg_stat_database` để chứng minh.
- **Mâu thuẫn đã kiểm:**
  - "hai process" (§1) và "vai trò scheduler": giải bằng S7-D12 (nhóm worker, không process mới).
  - `src/features/` là vùng dự án nhưng mẫu nằm ở đó: vùng template, tiền tố dài nhất thắng.
  - Bull Board read-only (SP2) và "retry trên Bull Board" (SP3): amendment B4.
  - Thứ tự migration của SP3 và clone: amendment B1.
  - Job hook không dùng ConfigMap nhưng Deployment dùng: có chủ đích (S7-D15), HC-8 và HC-10 kiểm cả hai.
  - Luật config không biết vai trò và allowlist theo vai trò của chart: C2, sửa ở nguồn (mục 6.5, amendment C3).
  - "Mọi cron tĩnh ở `maintenance`" (r0) và cron của mẫu/SP5 ở queue khác: quy ước S7-D34, §17 sửa.
  - Upstream ship file vùng dự án (SP4/SP5 r0) và luật UP-9: `projectSeed` + vùng template (S7-D36).
- **Mơ hồ đã khử:**
  - Quota đếm cả `ARCHIVED` (S7-D4).
  - Cổng tính năng không áp cho `GET`/`DELETE` (S7-D5).
  - Down migration mẫu từ chối khi còn dữ liệu, khi quyền còn được giữ, và khi SP4 còn dòng bộ đếm/override cho key của mẫu.
  - Participant không `release` quota.
  - Event xoá mang `version + 1`.
  - Thứ tự khoá dòng → bộ đếm ở mọi đường (S7-D35).
- **Phạm vi:** bám Phụ lục C mục 7 cộng các việc spec cha hoãn tới SP7:
  - mã hoá lại FieldCipher (§11);
  - chính sách chữ ký image (§13.1);
  - quy trình upstream (ADR 0002 "chưa quyết").
- **Những thứ thêm ngoài đề bài và lý do:**
  - `queue-admin`: runbook tồn đọng không có công cụ thì không làm được.
  - `AUTH_SECRETS`: runbook xoay khoá đúng đòi nó, và có fallback.
  - `WORKER_QUEUES_EXCLUDE`, khoá migrator, migrate tối thiểu: điều kiện cho chart đúng và quyền tối thiểu.
  - Composition lười, metadata secret và luật config theo vai trò (r1): điều kiện để "bỏ module" và "secret theo vai trò" đúng thật, không chỉ trên giấy.

---

## 25. Nhật ký sửa r1

Nguồn: `sp4-7-review-ops.md` (ops), `sp4-7-review-interfaces.md` (interfaces), `sp4-7-review-money-security.md` (money-security: không có finding nào riêng của SP7; SP4-I2/SP5-I5 về `order` purge được xử lý qua R-X5). Phán quyết: R-X3, R-X4, R-X5, R-X6, R-X7, R-X11.

| Finding | Sửa | Mục đổi |
|---|---|---|
| ops C1 (tắt module không tắt config/queue/job/cron) | Loader lười + top-level await; luật chéo module đăng ký theo tập module bật; `markModuleLoaded` phát hiện import module bị tắt; gỡ cron `static-<m>.*`; chọn loader thay cho gắn khoá module vì không đổi chữ ký `define*` nào | 0, 1 (tiêu chí 6), S7-D7, 6.2, 6.5, 17, 19 (UP-12b, UP-12c), 20, 21 (A1, A8), 22 (O-14, O-15), R7-17 |
| ops C2 (allowlist vai trò ↔ luật config không biết vai trò) | Sửa ở nguồn: `appPassword` optional + luật api/worker; `database-query-deadline` bỏ qua migrate; `smtp-auth-pair` chỉ worker; cặp Google/OIDC secret chỉ api, worker không dựng provider OAuth; allowlist sinh từ code; CO-4 ma trận vai trò; HC-K9 kind có SMTP AUTH thật, Google, `hybrid` qua mock-oauth2-server; bảng khoá theo vai trò | 0, 1 (tiêu chí 4), S7-D14, S7-D25, 6.5, 11.3, 12.4, 12.5, 12.9, 17, 19 (CO-3, CO-4, HC-7, HC-K9), 21 (A9, C3, D2) |
| ops I1 (regex tên secret) | Metadata `secret: { roles }` trên schema config; `pnpm chart:secrets` sinh `files/secret-env.json` và `$defs.secretEnvName` của schema; `--check` trong CI; áp cho `config`, `api.env`, `workers.*.env` | S7-D33, 6.4, 6.5, 12.1, 12.5, 12.9, 15, 19 (HC-6, HC-30) |
| ops I2 (khoá advisory trên connection của pool) | `pg.Client` riêng, `keepAlive`, mở trước `MikroORM.init`, giữ suốt lượt, `unlock` + `end()` trong `finally` ở mọi nhánh | 0, S7-D24, 6.5, 16 (R7-12), 18, 19 (CO-2, CO-2b) |
| ops I3 (`retryJobs` không lọc tên, không trả số) | Đã đọc `node_modules/bullmq` 6.3.8: chụp id qua `getJobs(['failed'], …)` theo trang, lọc tên, dừng ở `--max`, `job.retry('failed')` từng job, đếm `affected`/`skipped`; không cờ thì `retryJobs` và `affected: null`; `stats` không đòi TTY | 0, S7-D23, 6.5, 14.4, 16 (R7-15), 19 (QA-1, QA-4, QA-5, HC-K8) |
| ops I4 (NetworkPolicy thiếu egress S3/MinIO, clamd, IdP; cổng internet lệch SSRF) | Nhóm `objectStorage`, `clamd`, `idp`, `extra` theo vai trò; cổng internet = `RESILIENCE_ALLOWED_PORTS` của vai trò (bắt buộc đặt); `fail` khi `otel` bật mà thiếu egress; NOTES khi `RESILIENCE_SSRF_ALLOW_CIDRS` không có rule; D2 thêm phần egress của SP6 | 0, S7-D16, 12.1, 12.6, 14.1, 17, 19 (HC-16, HC-26, HC-27), 21 (D2) |
| ops I5 (kind smoke phụ thuộc vùng template) | `smoke.sh` chỉ dùng route boilerplate; bước mẫu có điều kiện `src/features/example` tồn tại; cùng luật cho mọi bước `ci.yml`; UP-13 chạy CI trên cây đã xoá template | 1 (tiêu chí 3), 6.4, 12.9, 19 (HC-K2, UP-13), 20 |
| ops I6 (`jobId` cố định trễ tới 7 ngày) | `jobId` có mốc cron theo lược đồ duy nhất của helper (per R-X4): `example-purge-<orgId>-<mốc>`; sửa câu "một chu kỳ"; thêm vào tập định danh | 6.3.3, 10.2, 16 (R7-9), 19 (EX-I12) |
| ops I7 (API SP4 cũ) | Dùng đúng `requireEnabled` (`EntitlementInterceptor`, sau mọi guard), `consumeOrThrow`, `releaseAllocation`, `defineFeatureCatalogue` + `@FeatureCatalogueContributor`, dòng `entitlement_features` bắt buộc | S7-D4, S7-D5, 6.3.1, 6.3.2, 7.2, 7.4, 7.5, 9.1, 10.4, 16, 19 (EX-U4, EX-E7, EX-E8, EX-I13, EX-I14) |
| ops I8 (độ phủ queue không kiểm; câu "mọi cron ở `maintenance`" sai) | `fail` tĩnh: phải có nhóm bắt-tất-cả, tên bị loại trừ phải có nhóm khác consume, queue tường minh không bị nhóm khác consume (gồm trường hợp tách nhóm quên `queuesExclude`); quy ước cron S7-D34, cron tỏa ra của mẫu chạy ở `maintenance`; sửa §17 | S7-D12, S7-D34, 10.2, 12.1, 14.4, 17, 19 (HC-25), 21 (A5, D2) |
| ops M1 (cờ Helm 4) | Lệnh chính xác `--wait --timeout <T_min>s`, không `--atomic`/`--force`; runbook đòi Helm ≥ 4.3; `hook-output-log-policy: hook-failed`; O-2 đóng | 3, S7-D15, 12.4, 14.1, 14.2, 14.3, 19 (RB-1, HC-8, HC-K4), 22 |
| ops M2 (ngân sách timeout của hook) | `T_min = D + G + 60`; `fail` khi `D ≤ G`; `fail` khi thiếu `DB_MIGRATION_STATEMENT_TIMEOUT_MS` (không chép mặc định của app); NOTES in `T_min` | 3, 12.4, 14.1, 17, 19 (HC-29) |
| ops M3 (lệnh down chạy tay) | Cùng `-f values` và `--set image.digest=<đang deploy>`; nhãn `component: migrate` cố định bất kể `nameSuffix` | 12.4, 14.3, 19 (HC-9) |
| ops M4 (squash: phát hiện muộn, không đường khôi phục) | Khôi phục `git merge -s ours --no-ff <tag>`; khuyến nghị ruleset chỉ merge commit; bộ kiểm chạy từ `check.mjs` của commit upstream | 1 (tiêu chí 6), 13.1, 13.2, 13.4, 15, 19 (UP-5, UP-6b) |
| ops M5 (ma sát vùng) | Spec/plan dự án ở `docs/app/`; release-please `simple`, không chạm `package.json.version`; `.dependency-cruiser.app.cjs` và `src/types/app/` là điểm mở rộng | S7-D10, 6.1, 6.5, 13.2, 13.5, 13.6, 22 (O-16) |
| ops M6 (re-encrypt mỗi 15 phút) | Mặc định mỗi giờ; keyring một kid thì bỏ quét ghi lại; đo `EXPLAIN` ở 7C | S7-D21, 6.5, 10.5, 11.2, 19 (KR-14) |
| ops M7 (OTel) | Chart đặt `OTEL_ENABLED=true`; Job migrate không phát telemetry, ghi rõ | 11.3, 12.2, 19 (HC-17) |
| ops M8 (bật/tắt HPA) | Ghi hành vi về 1 replica và thủ tục `kubectl scale` ngay sau upgrade | 12.3, 14.1 |
| ops M9 (dashboard mở trong cụm với allowlist loopback) | `fail` khi `ingressFrom` khác rỗng mà `ipAllowlist` còn `127.0.0.1/32` | 12.3, 19 (HC-28) |
| interfaces Q-2 (hợp đồng quota SP4 của mẫu) | Như ops I7; hai key riêng; `fallback` rộng; dòng `entitlement_features` vô điều kiện; down không `NO FORCE` bảng SP4 mà fail `23503` khi còn bộ đếm; phụ thuộc 4B. **Bác một phần:** nhận định "cả hai thứ tự khoá đều không deadlock" sai: consume trước rồi `INSERT` có chu trình thật qua chờ unique index với một `DELETE` chưa commit cùng `lower(name)` (bên chèn chờ bên xoá kết thúc; bên xoá chờ khoá bộ đếm). Vì vậy chốt thứ tự "dòng trước, bộ đếm sau" ở mọi đường | S7-D4, S7-D35, 6.3.2, 7.2, 7.4, 7.5, 10.4, 16 (R7-1, R7-8, R7-18), 19 |
| interfaces X-3 (cờ event) | Per R-X3: năm event khai `audit: true`, `webhook: false` tường minh; checklist bước 6 | 1, 6.3.1, 6.3.3, 10.1, 19 (EX-U4), 21 (D3) |
| interfaces X-4 (role definer) | Per R-X4: `sweep_definer` sở hữu hàm và nhận policy/grant cột; migration kiểm role đó; `DEFINER_LIMIT_MAX` từ core | S7-D2, 7.1, 7.3, 7.5, 13.5, 13.6, 19 (EX-I4, EX-I7, EX-I8), 21 (D3) |
| interfaces X-5 (`order` purge) | Per R-X5: mẫu = 200; bỏ quy ước "feature ≥ 1000" của r0 | 6.3.1, 6.3.3, 10.3, 19 (EX-I6), 21 (B5) |
| interfaces X-6 (upstream ship file vùng dự án; luật thứ tự migration) | `projectSeed`; `src/plans.example.ts` và `src/migrations/example/…_starter_*` ở vùng template, `upstream:init` chép sang vùng dự án với timestamp mới; S7-D31 viết lại "không `ALTER`/`DROP`, chỉ chèn dòng seed"; bỏ luật SP4 r0 | S7-D6, S7-D31, S7-D36, 6.1, 6.3.4, 13.2, 13.5, 19 (UP-9), 21 (D1) |
| interfaces X-7 (`EntitlementsModule.forApi(plans)` không compose được) | `composeAppModules({ disable, features, plans })`; mục `entitlements` dựng module với `plans`; ném khi thiếu | 6.2, 19 (UP-12), 21 (D1) |
| interfaces X-8 (phụ thuộc plan) | Per R-X7: bảng phụ thuộc thật theo plan và wave; rủi ro 3D | 20 |
| interfaces X-9 (số ADR) | Per R-X6: ADR 0021 (không theo bảng số của review) | 2, 20, 21 (A7, E4) |
| interfaces X-10 (bốn bản sao vòng lặp tỏa ra) | Per R-X4: mẫu dùng helper của core, chỉ khai nguồn org, job, tiền tố `jobId`; bỏ `FanOutPurgeHandler` | S7-D2, 6.3.1, 10.2, 11.1, 18, 21 (D3) |
| interfaces X-11 (tham chiếu SP3 r7, `EntitlementGuard`) | Per R-X11: trích SP3 r8 đã commit; bỏ `EntitlementGuard` | đầu spec, 6.3.2, 10.4 |
| interfaces X-12 (`grantTo.admin` đổi `A = perms(ADMIN)`) | Dòng Upgrade notes trong checklist chép mẫu | 6.3.3 |
| interfaces N-2 (câu về nhóm `scheduler`) | Như ops I8 (S7-D34, §17) | S7-D12, 17 |

**Tổng:** 31 finding. Sửa 31; bác một phần 1 (nhận định phụ trong Q-2, lý do ở trên). Hai finding của review interfaces có đề xuất cụ thể bị phán quyết thay (X-5 → R-X5, X-9 → R-X6): làm theo phán quyết, không tính là bác.

---

## 26. Nhật ký sửa r2

Nguồn: review hội tụ vòng 2 `sp4-7-review-r2.md` (finding cho SP7: X2-1, X2-2, X2-4 phần amendment, X2-m2) và phán quyết R-X12…R-X19. SP7 chỉ sửa phía mình; phía SP4, SP6 do spec của chúng mang (đã đối chiếu SP4 r2, SP6 r2), SP5 sửa song song. **Kết quả: 4 finding đã sửa, 0 finding bị từ chối.**

| Finding | Sửa | Mục đổi |
|---|---|---|
| X2-1 (không ai nạp adapter dung lượng) | Per R-X13: hằng `OPTIONAL_BRIDGES` trong `src/boilerplate.modules.ts` (7A tạo rỗng), bước 2b của `composeAppModules` nạp cầu nối khi đủ module trong `when` cùng bật, vào cả api lẫn worker; dòng `entitlements-files` do SP4 4B thêm; `loadedModules()` export ở `core/config` để module chủ port tự kiểm lúc boot (SP6 `FileStorageLimitCheck`); `gen-chart-secrets` không nạp cầu nối; test UP-12, UP-12d; rủi ro O-17 | Header, 6.2, 6.5, 19 (UP-12, UP-12d), 20 (7A), 21 D1, 22 O-17 |
| X2-2 (hàm definer của mẫu bị gọi sai thứ tự tham số) | Per R-X14: chữ ký đổi thành `(p_after uuid, p_limit integer, p_retention_sec integer)`; mẫu khai `defineOrgSweep({ …, extraParams: () => ({ p_retention_sec: … }) })` và handler mỏng `PurgeArchivedSweepHandler`; bỏ `SqlPurgeCandidates` và giả định callback `(cursor, limit)`; `jobId` theo slot của helper (thay chữ "mốc cron"); test EX-I8 (gọi như runner, không `RAISE`), EX-I12 (runner và hàm definer thật), EX-I15 (chữ ký qua `pg_proc`); amendment D3 viết lại; O-1 thu hẹp; bỏ câu điều kiện về tên env ở 11.1 | Header, 6.3.1, 6.3.3, 7.3, 10.2, 11.1, 16 R7-9, 19 (EX-I8, EX-I12, EX-I15), 20 (7D), 21 D3, 22 O-1, 24 |
| X2-4 (nghĩa vụ C1/D2 chưa được SP4/5/6 nhận) | Phía SP7: amendment D2 ghi rõ mỗi SP nhận `markModuleLoaded`, dòng `MODULE_REQUIRES` và `.meta({ secret })` trong spec của chính nó (R-X16), gồm dòng của SP4 (không có secret) và cách admin của SP6 đọc số liệu qua token `core/contracts` thay vì phụ thuộc files/integrations; hàng `core/config` của 6.5 ghi SP4/5/6 nhận nghĩa vụ; O-15 cập nhật | 6.5, 21 D2, 22 O-15 |
| X2-m2 (`_starter_prices` mà SP5 không ship) | Per R-X19: `upstream:init` chỉ chép `_starter_plans` của SP4; bỏ `_starter_prices`; thêm đoạn "Seed giá cho billing" trong `docs/boilerplate/README.md` (trỏ README của SP5, không chép cột), và `init` in bước tiếp theo nhắc viết migration giá của dự án | 6.3.4 |

Kèm theo (đối chiếu, không thuộc finding nào): registry order purge trích addendum 3D §A4 (có `integrations = 120`, luật `order < 1000`, dải 201–999 cho feature) ở 6.3.3, 10.3, 21 B5; 7D phụ thuộc 3D thêm lý do registry.


---

## 27. Sửa theo review plan 7B (2026-10-21)

Nguồn: hai review song song của plan `docs/superpowers/plans/2026-10-21-sp7b-helm.md` (spec/ops: 8 Important, 6 Minor; code: 2 Important, 8 Minor) và phán quyết R-X36. Phần sửa code/test nằm ở plan; dưới là phần spec.

| Finding | Sửa | Mục |
|---|---|---|
| I1 Job tên cố định + `before-hook-creation`: chạy lại upgrade xoá Job đang chạy | Tên `…-migrate<suffix>-r<revision>`, `ttlSecondsAfterFinished`; runbook kiểm trước khi chạy lại; khe tạo lại NetworkPolicy hook; HC-33, HC-K10; R7-19 | 12.1, 12.4, 14.1 (bước 8), 14.3, 16, 19 |
| I2 SIGKILL/mất TCP: backend ORM chạy tiếp câu dài | `client_connection_check_interval` mọi phiên; phiên khoá `idle_session_timeout=0` + keepalive; `on('error')` → `MigrationLockLostError`; CO-2c; R7-20 | 6.5, 16, 19 |
| I3 PDB chặn drain khi pod không khoẻ | `unhealthyPodEvictionPolicy: AlwaysAllow`; HC-12 | 12.3, 19 |
| I4 Budget bỏ qua `maxSurge` và pool của migrator | `peak = maxReplicas + ceil(maxSurge × maxReplicas)`; migrate = 1 khoá + `MIGRATION_ORM_POOL_MAX` (= 1) | 6.5, 12.5 |
| I5 SMTP ra internet buộc thêm cổng vào `RESILIENCE_ALLOWED_PORTS` | `smtp: { rules, internet: { ports } }`, rule riêng chỉ ở worker; HC-32 | 12.1, 12.6, 19 |
| I6 Kyverno khớp `@sha256:*` để lọt image theo tag | khớp repository, `validationConfigurations` (`verifyDigest`, `required`, `mutateDigest: false`); allowlist registry là policy cụm | 12.8 |
| I7 except-list thiếu dải; cụm IPv6/GUA | thêm 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4, 64:ff9b::/96; `exceptExtra`; runbook 14.1 bước 7 | 12.1, 12.6, 14.1 |
| I8 Rollback dưới ranh giới expand/contract | Theo R-X36: 7B chỉ ship bước runbook đối chiếu `helm history` ↔ Upgrade notes; guard ở DB là follow-up 7E (O-18) | 14.2, 22 |
| m1 Postgres egress chỉ cho nhóm relay | **Không áp:** mọi worker dùng `RelayDb` ngoài relay (dispatch, metric, readiness); ghi lý do | 12.6 |
| m2 PID 1 / SIGTERM | ghi giả định | 12.4 |
| m3 CRD catalog theo `main` | pin commit SHA trong `deploy/tools.env` | 12.9 |
| m4 release kẹt `pending-*`; deploy song song | runbook 14.1 bước 9; `concurrency` của workflow | 12.9, 14.1 |
| m5 hook sống sót `helm uninstall` | runbook 14.1 bước 10 | 14.1 |
| m6 digest theo vai trò (`api.image.digest`) | **Không thêm:** chart giữ một image cho mọi vai trò (S7-D14 không đổi, R-X36 dựa vào một `APP VERSION` mỗi revision); "worker trước api" của 6C là thao tác vận hành (chưa mở tính năng cho khách tới hết rollout worker), không cần hai image cùng lúc; digest theo vai trò mở ra trạng thái hai phiên bản kéo dài ngoài cửa sổ rollout mà Upgrade notes không mô tả | — |
| NodeLocal DNS | ghi đè `egress.dns` bằng `169.254.20.10/32` | 12.6, 14.1 |
| M8 `OTEL_EXPORTER_OTLP_HEADERS` trong ConfigMap | thuộc `chartOwnedEnvName` (cấm trong `config`), qua `secretEnvExtra` | 12.5 |
