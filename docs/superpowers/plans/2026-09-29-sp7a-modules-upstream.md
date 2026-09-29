# Sub-project 7 — Plan 7A: composition module lười và quy trình upstream — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm composition nạp module lười (`src/boilerplate.modules.ts`, `composeAppModules`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES` rỗng, `markModuleLoaded`/`loadedModules`, gỡ cron của module bị tắt, luật config chéo module theo tập module bật, `gen-env-example` đọc composition) và quy trình upstream có công cụ (`.upstream/zones.json`, `tools/upstream/{check,init,sync}.mjs`, workflow `upstream-guard` chạy bộ kiểm của commit upstream, job "upgrade path", release-please `simple`, `docs/upstream/*`), cùng các điểm mở rộng cho dự án (glob inventory chuẩn hoá, `.dependency-cruiser.app.cjs`, thứ tự migration theo vùng), chứng minh bằng test trên Testcontainers, repo git tạm thật và image production qua `docker compose --profile app`.

**Architecture:** Ở codebase này import một module là đăng ký trạng thái toàn cục (config, luật config, queue, job, cron). Vì vậy "tắt module" chỉ đúng khi module **không bao giờ được import**: `BOILERPLATE_MODULES` là bảng loader `() => import('./modules/<m>/index.js')`, `src/app.modules.ts` gọi `await composeAppModules({ disable, features })` bằng top-level await, và `composeFrom` kiểm phụ thuộc (`MODULE_REQUIRES`), nạp module bật, nạp cầu nối tuỳ chọn, đăng ký luật chéo module, rồi đối chiếu `loadedModules()` (mỗi `index.ts` gọi `markModuleLoaded`) để bắt mọi import lọt của module bị tắt; tập module tắt được ghi cho `StaticScheduler` gỡ `static-<m>.*`. Quy trình upstream dựa trên so cây git: vùng boilerplate ở `HEAD` phải trùng cây của commit upstream ghi trong `.upstream/version.json` (và commit đó là tổ tiên của `HEAD`), bộ kiểm chạy từ bản `check.mjs` **của commit upstream**; `sync.mjs` là state machine suy ra từ git; `init.mjs` chép phần hạt giống và xoá vùng template.

**Tech Stack:** NestJS 12.1 (ESM, SWC `es2022`, top-level await), Node 24.21 (`node --run`, `node:child_process`, `node:readline/promises`), git ≥ 2.28, Vitest 5 + Testcontainers, MikroORM 7.2.1 migrator, BullMQ 6.3.8 Job Schedulers, dependency-cruiser 18.4, release-please 17.6 qua `googleapis/release-please-action` v5.0.0, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` (r2, đã chốt; mục 20 hàng 7A là nguồn phạm vi; mục 6.1, 6.2, 6.3.4, 6.5 hàng "7A", 13, 16 R7-16/R7-17, 19 UP-1…UP-12d, 21 A1/B1/B5/C2/E1). Kèm theo, cùng ràng buộc: phán quyết chéo `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` (R-X7: 7A chỉ phụ thuộc 3A; R-X13: `OPTIONAL_BRIDGES` rỗng; R-X16: nghĩa vụ `markModuleLoaded` + `MODULE_REQUIRES` của SP4/5/6), spec SP3 r8, addendum SP3, spec cha. Mẫu định dạng: `docs/superpowers/plans/2026-09-28-sp3a-tenancy-foundation.md`.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2 và 3A (Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md`), cộng các luật của SP7 (spec §3) cho plan này:

- **Plan chạy SAU khi 3A merge vào `main`.** Nhánh `sp7a-modules-upstream` tạo từ `origin/main` có 3A (Task 1 Step 1 kiểm `src/modules/tenancy/index.ts` và `TenancyModule` tồn tại). Tên 3A tạo ra mà plan này dùng lấy từ Produces của plan 3A: `TenancyModule.forApi()`/`.forWorker()` export ở `src/modules/tenancy/index.ts` (Task 19), cron `tenancy.orgs.purge` ở queue `maintenance` (Task 25), `src/app.modules.ts` có `TenancyModule` sau identity + notifications (Task 19), `test/support/scratch-db.ts` (`createScratchDb`), `test/support/app-process.ts` (`startAppProcess`/`stopAppProcess`).
- **Package-first:** 7A **không thêm dependency nào** (npm `yaml` thuộc 7B). Công cụ `tools/upstream/*.mjs` là Node ESM thuần, chỉ `node:child_process`, `node:fs`, `node:path`, `node:readline/promises`: chạy được trước `pnpm install` (spec §13.1). `check.mjs` là **một file**, không import tương đối, để chạy được từ stdin.
- **Action pin theo commit SHA** như CI hiện có: `googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0` (tag v5.0.0 là lightweight tag trỏ thẳng commit này, đọc bằng GitHub API ngày 2026-09-29); `actions/checkout`, `actions/setup-node`, `pnpm/action-setup` dùng lại đúng SHA đang có trong `.github/workflows/ci.yml`.
- **Không đoán API (đã đối chiếu lúc viết plan):**
  - release-please strategy `simple` mặc định `versionFile = 'version.txt'` và cập nhật nó với `createIfMissing: false` (`dist/index.js` của action v5.0.0, lớp `Simple`), nên repo phải có sẵn `version.txt`; bundle dùng release-please `17.6.0`, schema config lấy ở tag `v17.6.0` (`schemas/config.json`, draft-07, `additionalProperties: false` ở gốc, có `$schema`, `packages`, `release-type`, `include-component-in-tag`, `include-v-in-tag`, `changelog-sections`).
  - Input của action: `token`, `config-file`, `manifest-file` (`action.yml` ở SHA trên).
  - MikroORM tạo tên migration bằng `new Date().toISOString().replace(/[-T:]|\.\d{3}z$/gi, '')` (`node_modules/@mikro-orm/migrations/MigrationGenerator.js:20`); `init.mjs` dùng đúng công thức này để đặt timestamp mới cho migration hạt giống (lý do không gọi CLI: `init` phải chạy không cần `node_modules` trong test repo tạm; tên sinh ra giống hệt CLI).
  - `ConditionalModule.registerWhen` của `@nestjs/config` 12.0.1 đặt timer `unref()` (`conditional.module.js`), nên script chỉ import composition (không dựng Nest) vẫn tự thoát.
  - BullMQ 6.3.8 thêm lần chạy kế của một Job Scheduler khi **worker xử lý** job hiện tại (`classes/worker.js:525-537` gọi `upsertJobScheduler`): scheduler trên queue không ai consume giữ tối đa một job chờ (dùng cho R7-17 và giới hạn ở Review Focus).
  - `node --input-type=module -` và `node <file>`: tham số của script đều ở `process.argv.slice(2)` (đã chạy thử trên Node 24.19).
- **TDD, không `any`, không `as never`, không tắt lint, không tắt type-check.** Test integration phải cho thấy RED trước (ledger 3A); ca không thể RED bằng cách viết test trước (test đi sau code của task trước) thì RED bằng đột biến tạm có ghi rõ lệnh hoàn tác `git checkout -- <file>`.
- **Không hard code:** mọi hằng trong công cụ là hằng có tên ở đầu file; vùng sở hữu chỉ nằm ở `.upstream/zones.json`; `test/unit/architecture/hardcode-scan.spec.ts` xanh.
- **Fail loud:** composition sai (khoá trùng/lạ, tắt module đang được cần, cầu nối nêu module lạ, module tắt mà vẫn bị import, module bật mà không gọi `markModuleLoaded`) → ném lỗi có tên module, app không khởi động; guard vùng in **mọi** vi phạm rồi exit 1; `sync` gặp trạng thái git lạ → exit 1; `version.json`/`zones.json` sai dạng → thông điệp rõ, không stack trace.
- **Migration:** 7A không có migration nào (không có bảng mới). Pipeline migration up → down → up + sweep S2-R57 vẫn chạy trong `pnpm test:int` như cũ và phải xanh. Test UP-10 chứng minh migration upstream có timestamp cũ hơn migration dự án vẫn chạy (MikroORM `getPending`).
- **Kiểm chứng prod-like (bắt buộc):** cuối nhóm composition (Task 4) và cuối plan (Task 12) chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với `NODE_ENV=production`, TLS, PgBouncer; smoke mới `test/smoke/composition.smoke.spec.ts` chứng minh `dist/app.modules.js` (top-level await) chạy trên image và worker đồng bộ cron của mọi module bật. Task 12 ghi kích thước image vào ADR 0013 (mục "Số đo SP7 (7A)").
- **Định dạng:** trước mỗi commit chạy `pnpm exec prettier --write <file đã đổi ngoài docs/>` (gồm `tools/**/*.mjs`, `.github/workflows/*.yml`, `.upstream/zones.json`, `*.json`); `docs/` nằm trong `.prettierignore`.
- **Commit:** mỗi task một commit trở lên, conventional message tiếng Anh. Push và mở PR chỉ ở Task 13, và chỉ khi Sếp đã cho phép push/PR cho plan này (hard stop của CLAUDE.md).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không mã test nào của spec phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Path có khoảng trắng hoặc ký tự ngoài ASCII** (ví dụ `docs/superpowers/ghi chú.md`, tên file tiếng Việt trong `docs/app/`): `git ls-tree` mặc định quote path như vậy (`core.quotePath`), bộ kiểm tách dòng sai sẽ bỏ sót hoặc báo path rác. Mong đợi: phân vùng đúng, vi phạm in đúng path gốc kèm gợi ý `docs/app/`. Test: Task 6 (`reports a modified path with spaces and non-ASCII characters exactly, with the docs/app hint`).
2. **`.upstream/version.json` hỏng do sửa tay** (JSON lỗi, `commit` rút gọn 7 ký tự, thiếu `tag`, file vắng): mong đợi exit 1 với một dòng nêu đúng lỗi, không stack trace Node. Test: Task 6 (`a malformed version.json fails with one clear line and no stack trace`).
3. **`pnpm upstream:sync` với tag không hợp lệ cho bước này**: tag bằng hoặc cũ hơn bản hiện tại, tag không nằm trên `upstream/main` (tag của nhánh phụ), chạy trên `main` thay vì `chore/upstream-*`, gõ sai tag ở bước xác nhận Upgrade notes. Mong đợi: exit 1 với thông điệp nêu lý do, cây làm việc không đổi, không có `MERGE_HEAD`. Test: Task 8 (`refuses a non-newer tag, a tag off upstream/main, the wrong branch and a wrong confirmation, leaving the tree untouched`).
4. **Bật lại module đã tắt**: sau khi gỡ `static-<m>.*`, bật lại module phải đồng bộ lại cron (không để module bật mà cron không chạy). Mong đợi: lần boot bật lại có `static-<m>.tick` trong Redis. Test: Task 4 (`enable → disable → re-enable`, pha 3).
5. **Chạy `pnpm upstream:check` khi cây làm việc còn thay đổi chưa commit**: bộ kiểm so **commit** (`HEAD`), nên sửa `src/core/` chưa commit không bị báo; lập trình viên tưởng đã sạch. Mong đợi: kết quả vẫn về `HEAD` nhưng in cảnh báo liệt kê thay đổi chưa commit bị bỏ qua. Test: Task 6 (`warns that uncommitted changes are not checked`).

Giới hạn có tên (không sửa, ghi README): cron của module bị tắt mà job của nó nằm trên queue **riêng** của module đó không được `listIds` thấy (chỉ quét queue đã đăng ký); theo BullMQ (mục Global Constraints) scheduler đó giữ tối đa một job chờ không ai consume. Quy ước S7-D34 (job cron dọn dẹp/tỏa ra ở `maintenance`) tránh trường hợp này cho mọi cron hiện có.

---

## File Structure

```
src/
  boilerplate.modules.ts            (mới) ModuleImport, ModulePair, AppFeatures, ComposeOptions, ModuleEntry, OptionalBridge,
                                    Composition, BOILERPLATE_MODULES, BoilerplateModuleKey, MODULE_REQUIRES,
                                    OPTIONAL_BRIDGES (rỗng), composeFrom, composeAppModules
  app.modules.ts                    APP_MODULES = await composeAppModules({ disable: [], features })  (top-level await)
  composition.config.ts             registerCompositionRules(enabled) — bỏ import tĩnh index identity/notifications
  core/config/module-registry.ts    (mới) markModuleLoaded, loadedModules
  core/config/index.ts              export hai hàm trên
  core/scheduler/cron-definition.ts setDisabledModuleKeys, disabledModuleKeys, cronKeyModule
  core/scheduler/static-scheduler.ts sync() gỡ thêm static-<m>.* của module bị tắt; ném nếu module tắt còn cron
  core/scheduler/index.ts           export ba hàm trên
  modules/{notifications,identity,tenancy}/index.ts   dòng đầu: markModuleLoaded('<m>')
  scripts/gen-env-example.ts        import '../app.modules.js' thay cho config từng module
.upstream/zones.json                (mới) vùng sở hữu + projectSeed
tools/upstream/check.mjs            (mới) guard vùng (so cây, kiểm theo khoá, --self, --rev)
tools/upstream/init.mjs             (mới) khởi tạo clone
tools/upstream/sync.mjs             (mới) merge một tag upstream (state machine)
.github/workflows/upstream-guard.yml (mới) zones (self | clone từ commit upstream) + upgrade-path
.github/workflows/release-please.yml (mới) chỉ chạy khi vars.BOILERPLATE_UPSTREAM == 'true'
release-please-config.json · .release-please-manifest.json · version.txt · CHANGELOG.md   (mới)
.dependency-cruiser.cjs             nạp .dependency-cruiser.app.cjs nếu có
.prettierignore                     + CHANGELOG.md (release-please ghi)
package.json                        + upstream:check|sync|init|regenerate|verify, test:upgrade
vitest.config.ts                    + project upgrade
README.md                           còn tên + liên kết (hạt giống vùng dự án)
docs/boilerplate/README.md          (chuyển từ README.md) + vùng sở hữu, khởi tạo dự án, composition, tắt module, quy ước cron,
                                    tạo feature từ mẫu
docs/upstream/merge.md · semver.md · CODEOWNERS.template   (mới)
docs/adr/0002-clone-and-upstream.md (kết quả spike + cập nhật SP7 7A) · 0013 (số đo SP7 (7A))
docs/superpowers/specs/  2026-09-24-saas-core-architecture-design.md (A1), 2026-09-27-sp2-…-design.md (C2),
                         2026-09-28-sp3-tenancy-access-design.md (B1, B5)
test/
  support/  feature-inventory.ts · migration-zones.ts · upstream-fixture.ts
            composition-probe.ts · composition-feature-probe.ts · composition-worker-entry.ts
  fixtures/composition/fixturemod/index.ts · fixtures/composition/tenancy-importing-feature.ts
  unit/     composition/compose.spec.ts · composition/composition-rules.spec.ts · core/config/module-registry.spec.ts
            core/scheduler/static-scheduler.spec.ts (sửa) · modules/notifications/retention-outlives-token-ttl-rule.spec.ts (sửa)
            support/feature-inventory.spec.ts · migrations/migration-zones.spec.ts · migrations/migration-order.spec.ts (sửa)
            architecture/app-rules-hook.spec.ts
            upstream/check.spec.ts · upstream/self.spec.ts · upstream/init.spec.ts · upstream/sync.spec.ts
            upstream/codeowners-template.spec.ts · upstream/release-config.spec.ts
  integration/ composition/module-isolation.spec.ts · composition/disable-module.spec.ts
            upstream/out-of-order-migrations.spec.ts · core/database/normalization-inventory.spec.ts (sửa)
  upgrade/  upgrade-path.spec.ts (project Vitest `upgrade`, chỉ job upgrade-path chạy)
  smoke/    composition.smoke.spec.ts
```

**Lệch có chủ đích so với chữ của spec (mỗi dòng có lý do):**

- **Hình dạng `app.modules.ts`.** Spec 6.2 viết `features: { api: [ExampleModule.forApi()], worker: [...] }`. Plan dùng `const features: AppFeatures = { api: [], worker: [] }` rồi `features.api.push(...)` từng dòng, và dòng thuộc vùng template kết thúc bằng `// upstream:template`. Lý do: `upstream:init` xoá **nguyên dòng** có dấu đó; xoá phần tử trong mảng nhiều dòng để lại `[\n  ]` mà prettier đổi thành `[]` (cây vừa khởi tạo đỏ `pnpm lint`). Cách `push` cho kết quả ổn định với prettier. Ngữ nghĩa composition không đổi.
- **`registerCompositionRules(enabled: ReadonlySet<string>)`** thay vì `ReadonlySet<BoilerplateModuleKey>`: `boilerplate.modules.ts` import `composition.config.ts`, nên kiểu ngược lại tạo vòng import (dependency-cruiser đặt `tsPreCompilationDeps: true`, luật `no-circular` bắt cả import kiểu).
- **`composeFrom(composition, opts)`** nhận cả `requires`, `bridges`, `registerRules` (spec: `composeFrom(entries, opts)`), để test fixture (UP-12b, UP-12d) có bảng phụ thuộc và luật riêng mà không đụng hằng thật.
- **Bước 4 của composition kiểm cả chiều ngược lại**: module bật mà `index.ts` không gọi `markModuleLoaded` → ném. Spec O-15 dựa vào UP-12c để bắt quên nghĩa vụ này; kiểm lúc boot bắt nó ở mọi process, không chỉ ở CI.
- **`sync.mjs` chạy `node --run upstream:regenerate` / `upstream:verify`** (script của `package.json`, vùng chung, khoá do upstream giữ theo 13.3) thay cho chuỗi lệnh viết cứng trong script: test dùng repo tạm với script rẻ, còn repo thật chạy đúng các lệnh của spec 13.4 bước 6–7. `upstream:check` ở bước kiểm chạy trên **commit tạm** của kết quả merge (`git commit-tree`, không cập nhật ref) qua `check.mjs --rev`, vì lúc đó merge chưa commit và `HEAD` vẫn là phía dự án.
- **Kiểm `pnpm-workspace.yaml` theo dòng trong từng mục cấp một** (không parse YAML: `check.mjs` không có dependency). Mọi dòng không phải chú thích của upstream phải có ở `HEAD` dưới cùng khoá cấp một; dự án chỉ thêm. Với file hiện tại (khoá vô hướng, map `allowBuilds`/`catalog`/`overrides`) điều này đúng ngữ nghĩa spec 13.3; chặt hơn ở chỗ đổi cách quote một dòng của upstream cũng bị báo.
- **`extra-files: Chart.yaml` của release-please** thuộc 7B (chart chưa tồn tại ở 7A); 7B thêm mục này khi tạo `deploy/helm/saas-app/Chart.yaml`.

---

## Phần A — Spike (bắt buộc làm trước mọi task khác)

### Task 1: Nhánh làm việc; spike O-14 (top-level await qua mọi công cụ), O-16 (tệp version của release-please), hành vi scheduler BullMQ không có worker; ghi kết quả vào ADR 0002

**Files:**
- Modify: `docs/adr/0002-clone-and-upstream.md`
- Tạm (không commit, hoàn tác cuối task): `src/app.modules.ts`

**Interfaces:**
- Consumes: `origin/main` có 3A (`src/modules/tenancy/index.ts`, `TenancyModule`).
- Produces: nhánh `sp7a-modules-upstream`; mục "Kết quả spike (plan 7A)" trong ADR 0002 với ba dòng S7A-1 (O-14), S7A-2 (O-16), S7A-3 (BullMQ) đã điền bằng output thật. Không đạt S7A-1 → **dừng**, báo Sếp (không có fallback trong spec: composition lười dựa hẳn vào top-level await, O-14).

- [ ] **Step 1: Tạo nhánh từ `main` đã có 3A**

Run:
```bash
git fetch origin main
git switch -c sp7a-modules-upstream origin/main
test -f src/modules/tenancy/index.ts && grep -n "export { TenancyModule }" src/modules/tenancy/index.ts
grep -n "TenancyModule" src/app.modules.ts
test -f src/modules/entitlements/index.ts && echo "4A ĐÃ MERGE: áp Task 3 Step 6" || echo "4A chưa merge: bỏ qua Task 3 Step 6"
```
Expected: dòng export `TenancyModule` và dòng dùng nó trong `app.modules.ts` được in; dòng cuối nói 4A đã merge hay chưa (ghi lại để dùng ở Task 3). Thiếu `TenancyModule` → **dừng**: plan này chỉ chạy sau khi 3A merge.

- [ ] **Step 2: Spike S7A-1 (O-14) — top-level await trong `app.modules.ts` qua bốn công cụ**

Thêm tạm đúng một dòng vào cuối `src/app.modules.ts`:
```ts
await Promise.resolve();
```
Run (mỗi lệnh đọc output thật):
```bash
pnpm build
node --input-type=module -e "const m = await import('./dist/app.modules.js'); console.log('dist TLA ok', m.APP_MODULES.api.length, m.APP_MODULES.worker.length)"
pnpm env:example && git diff --stat .env.example .env.infra.example
pnpm openapi:export && git diff --stat openapi.json
pnpm vitest run --project integration test/e2e/core/entrypoints.e2e.spec.ts
```
Expected:
- `dist TLA ok 3 3` (SWC `es2022` + `module: es6` giữ top-level await; Node 24 ESM chạy được);
- `pnpm env:example` chạy qua `@swc-node/register/esm-register` không lỗi, không diff;
- `openapi:export` (dựng `AppApiModule`) không lỗi, không diff;
- e2e entrypoints (Vitest + `unplugin-swc`, `AppApiModule`/`AppWorkerModule`) xanh.
Bất kỳ công cụ nào lỗi `Top-level await is not available`/`ERR_REQUIRE_ASYNC_MODULE` → **dừng**, ghi output vào ADR 0002 và báo Sếp.

Hoàn tác:
```bash
git checkout -- src/app.modules.ts
git status --short
```
Expected: cây sạch.

- [ ] **Step 3: Spike S7A-2 (O-16) — tệp version mặc định của strategy `simple` trong bundle của action v5.0.0**

Run:
```bash
git ls-remote https://github.com/googleapis/release-please-action refs/tags/v5.0.0
curl -sL https://raw.githubusercontent.com/googleapis/release-please-action/45996ed1f6d02564a971a2fa1b5860e934307cf7/dist/index.js -o "$TMPDIR/rpa-v5.js"
grep -n "this.versionFile = " "$TMPDIR/rpa-v5.js"
grep -n -A6 "path: this.addPath(this.versionFile)" "$TMPDIR/rpa-v5.js"
curl -sL https://raw.githubusercontent.com/googleapis/release-please-action/45996ed1f6d02564a971a2fa1b5860e934307cf7/package.json | grep '"release-please"'
```
Expected: `45996ed1f6d02564a971a2fa1b5860e934307cf7	refs/tags/v5.0.0`; `this.versionFile = (_a = options.versionFile) !== null && _a !== void 0 ? _a : 'version.txt';`; khối update có `createIfMissing: false`; dependency `"release-please": "^17.6.0"`. Khác → dừng, cập nhật Task 10 theo giá trị thật và báo Sếp.

- [ ] **Step 4: Spike S7A-3 — scheduler BullMQ trên queue không có worker**

Run:
```bash
sed -n 520,545p node_modules/bullmq/dist/esm/classes/worker.js
grep -n '"version"' node_modules/bullmq/package.json
```
Expected: `"version": "6.3.8"`; đoạn code cho thấy worker gọi `jobScheduler.upsertJobScheduler(job.repeatJobKey, …)` khi lấy job của scheduler (lần chạy kế chỉ được thêm khi có worker xử lý). Khác → ghi lại và báo: giới hạn ở Review Focus phải viết lại.

- [ ] **Step 5: Ghi kết quả spike vào ADR 0002**

Thêm vào `docs/adr/0002-clone-and-upstream.md`, ngay trước `## Nguồn`:
```markdown
## Kết quả spike (plan 7A)

Chạy trên nhánh `sp7a-modules-upstream` (từ `main` đã có 3A), Node 24.21, Nest 12.1, SWC 1.16.2, Vitest 5.0.1.

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S7A-1 (O-14) | Top-level await trong `src/app.modules.ts` có chạy qua `nest build` + Node, `@swc-node/register` (`pnpm env:example`), `openapi:export`, Vitest (`unplugin-swc`) không? | Đạt | `node --input-type=module -e "…import('./dist/app.modules.js')…"` in `dist TLA ok 3 3`; `pnpm env:example`, `pnpm openapi:export` không lỗi, không diff; `test/e2e/core/entrypoints.e2e.spec.ts` xanh |
| S7A-2 (O-16) | Tệp version mặc định của release-please strategy `simple` trong action v5.0.0 | `version.txt`, cập nhật với `createIfMissing: false` (repo phải có sẵn file) | `dist/index.js` của `googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7` (tag v5.0.0), lớp `Simple`; bundle phụ thuộc `release-please ^17.6.0` |
| S7A-3 | Scheduler BullMQ trên queue không có worker có sinh job vô hạn không? | Không: lần chạy kế chỉ được thêm khi worker xử lý job của scheduler, nên tối đa một job chờ | `node_modules/bullmq/dist/esm/classes/worker.js:525-537` (BullMQ 6.3.8) |
```
Nếu Step 2–4 cho số khác (ví dụ số module), chép đúng output thật vào cột "Bằng chứng" trước khi commit.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0002-clone-and-upstream.md
git commit -m "docs(adr): record the SP7 plan 7A spikes (top-level await composition, release-please version file, BullMQ scheduler without a worker)"
```

---
## Phần B — Composition module lười (spec §6.2, S7-D7, C1)

### Task 2: `core/config` — `markModuleLoaded`/`loadedModules`; `core/scheduler` — tập module bị tắt và gỡ `static-<m>.*`

**Files:**
- Create: `src/core/config/module-registry.ts`, `test/unit/core/config/module-registry.spec.ts`
- Modify: `src/core/config/index.ts`, `src/core/scheduler/cron-definition.ts`, `src/core/scheduler/static-scheduler.ts`, `src/core/scheduler/index.ts`, `test/unit/core/scheduler/static-scheduler.spec.ts`

**Interfaces:**
- Consumes: `cronRegistry`, `retiredCrons`, `staticCronId`, `STATIC_PREFIX`, `JobScheduler.listIds/remove/upsert` (SP1).
- Produces:
  - `markModuleLoaded(key: string): void` (ném khi khoá không khớp `/^[a-z][a-z0-9-]{0,62}$/`), `loadedModules(): ReadonlySet<string>` (bản sao), export ở `src/core/config/index.ts`.
  - `setDisabledModuleKeys(keys: readonly string[]): void`, `disabledModuleKeys(): ReadonlySet<string>`, `cronKeyModule(key: string): string` (phần trước dấu `.` đầu tiên), export ở `src/core/scheduler/index.ts`.
  - `StaticScheduler.sync()` trả `{ upserted, removed }`, trong đó `removed` gồm cron đã `retireCron` **và** mọi `static-<m>.*` có `m ∈ disabledModuleKeys()`; ném trước khi upsert nếu một cron đang được định nghĩa thuộc module bị tắt.

- [ ] **Step 1: Test registry module (fail)**

`test/unit/core/config/module-registry.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  loadedModules,
  markModuleLoaded,
} from '../../../../src/core/config/index.js';

describe('module registry (spec SP7 §6.2 bước 4, C1)', () => {
  it('records each module once and returns a copy', () => {
    markModuleLoaded('mr-alpha');
    markModuleLoaded('mr-alpha');
    const first = loadedModules();
    expect([...first].filter((k) => k === 'mr-alpha')).toEqual(['mr-alpha']);
    markModuleLoaded('mr-beta');
    expect(first.has('mr-beta')).toBe(false);
    expect(loadedModules().has('mr-beta')).toBe(true);
  });
  it.each(['', 'Identity', '1files', 'files.x', 'a'.repeat(64)])(
    'rejects the malformed key %j',
    (key) => {
      expect(() => markModuleLoaded(key)).toThrow(/must match/);
    },
  );
});
```

- [ ] **Step 2: Thêm test gỡ cron của module bị tắt vào `static-scheduler.spec.ts` (fail)**

`test/unit/core/scheduler/static-scheduler.spec.ts` — sửa import và thêm lớp + ca mới (giữ nguyên hai ca cũ):
```ts
import {
  StaticScheduler,
  defineCron,
  setDisabledModuleKeys,
} from '../../../../src/core/scheduler/index.js';
```
Thêm sau lớp `RecordingScheduler`:
```ts
/** Redis giả đã có sẵn các scheduler `ids` (từ lần chạy trước); ghi lại id được upsert và id bị gỡ. */
class ListingScheduler extends JobScheduler {
  readonly upserted: string[] = [];
  readonly removed: string[] = [];
  constructor(private readonly ids: string[]) {
    super();
  }
  async upsert(
    id: string,
    _job: JobDef,
    _payload: unknown,
    _pattern: SchedulePattern,
  ): Promise<void> {
    this.upserted.push(id);
  }
  async remove(id: string): Promise<void> {
    this.removed.push(id);
  }
  async listIds(): Promise<string[]> {
    return this.ids;
  }
  async get(): Promise<undefined> {
    return undefined;
  }
}
```
Thêm vào cuối `describe('StaticScheduler.sync', …)`:
```ts
  describe('disabled modules (spec SP7 §6.2, C1, R7-17)', () => {
    afterEach(() => setDisabledModuleKeys([]));

    it('removes static-<m>.* of a disabled module and nothing else', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      setDisabledModuleKeys(['fixturemod']);
      const s = new ListingScheduler([
        'static-fixturemod.tick',
        'static-fixturemodx.other',
        'static-identity.purge-expired',
        'static-core.outbox.cleanup',
      ]);
      const r = await new StaticScheduler(s, appConfig()).sync();
      expect(s.removed).toEqual(['static-fixturemod.tick']);
      expect(r.removed).toEqual(['static-fixturemod.tick']);
    });

    it('keeps every existing scheduler when no module is disabled', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      const s = new ListingScheduler(['static-fixturemod.tick']);
      await new StaticScheduler(s, appConfig()).sync();
      expect(s.removed).toEqual([]);
    });

    it('fails before upserting anything when a disabled module still defines a cron', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      // Mọi cron của file này có khoá `test.static.*`, tức thuộc "module" `test`.
      setDisabledModuleKeys(['test']);
      const s = new ListingScheduler([]);
      await expect(new StaticScheduler(s, appConfig()).sync()).rejects.toThrow(
        /"test\.static\.a-healthy".*belong to a disabled module/,
      );
      expect(s.upserted).toEqual([]);
    });
  });
```

- [ ] **Step 3: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/core/config/module-registry.spec.ts test/unit/core/scheduler/static-scheduler.spec.ts`
Expected: FAIL — `markModuleLoaded is not a function` / `setDisabledModuleKeys` không export.

- [ ] **Step 4: Cài đặt**

`src/core/config/module-registry.ts`:
```ts
/** Khoá module: cùng dạng tiền tố khoá cron (`<module>.<tên>`), không có `.`. */
const MODULE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const loaded = new Set<string>();

/**
 * Ghi rằng module nền `key` đã được import trong process này (spec SP7 §6.2 bước 4, C1). Dòng đầu của mỗi
 * `src/modules/<m>/index.ts` gọi hàm này: import một module là đăng ký config, luật config, queue, job, cron của nó,
 * nên composition so tập này với tập module đang bật để bắt module bị tắt mà vẫn bị import.
 */
export function markModuleLoaded(key: string): void {
  if (!MODULE_KEY_PATTERN.test(key))
    throw new Error(`Module key "${key}" must match ${MODULE_KEY_PATTERN}`);
  loaded.add(key);
}

/**
 * Tập module đã import (bản sao). Sau `composeAppModules`, bằng đúng tập module đang bật: module khác dùng nó để biết
 * một module có bật hay không mà KHÔNG import module đó (R-X13, SP6 `FileStorageLimitCheck`).
 */
export const loadedModules = (): ReadonlySet<string> => new Set(loaded);
```
`src/core/config/index.ts` — thêm dòng:
```ts
export { markModuleLoaded, loadedModules } from './module-registry.js';
```
`src/core/scheduler/cron-definition.ts` — thêm cuối file:
```ts
let disabledModules: ReadonlySet<string> = new Set();

/**
 * Composition ghi tập module bị tắt (spec SP7 §6.2 bước 5); `StaticScheduler.sync()` gỡ `static-<m>.*` của chúng
 * khỏi Redis. Thay toàn bộ tập mỗi lần gọi.
 */
export function setDisabledModuleKeys(keys: readonly string[]): void {
  disabledModules = new Set(keys);
}
export const disabledModuleKeys = (): ReadonlySet<string> => disabledModules;

/** Module chủ của khoá cron: phần trước dấu `.` đầu tiên (quy ước `<module>.<tên>`, giữ bằng test UP-12c). */
export const cronKeyModule = (key: string): string => {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
};
```
`src/core/scheduler/index.ts` — đổi dòng export của `cron-definition.js` thành:
```ts
export {
  defineCron,
  retireCron,
  setDisabledModuleKeys,
  disabledModuleKeys,
  cronKeyModule,
  type CronDef,
} from './cron-definition.js';
```
`src/core/scheduler/static-scheduler.ts` — import và thân `sync()`:
```ts
import {
  cronKeyModule,
  cronRegistry,
  disabledModuleKeys,
  retiredCrons,
  type CronDef,
} from './cron-definition.js';
```
Thay chú thích lớp dòng cuối "Chỉ xoá cron đã `retireCron`." bằng: "Chỉ xoá cron đã `retireCron` hoặc thuộc module bị tắt (`static-<m>.*`, spec SP7 §6.2; rolling deploy: pod bản cũ khởi động lại có thể upsert lại, pod bản mới kế tiếp gỡ tiếp, R7-17)." Thay thân `sync()`:
```ts
  async sync(): Promise<{ upserted: string[]; removed: string[] }> {
    const disabled = disabledModuleKeys();
    const defined = cronRegistry();
    const stray = defined.filter((c) => disabled.has(cronKeyModule(c.key)));
    if (stray.length)
      throw new Error(
        `Static crons ${stray.map((c) => `"${c.key}"`).join(', ')} belong to a disabled module but are still defined; the disabled module was imported (composeAppModules refuses this at boot)`,
      );
    const planned = defined.map((c) => ({ c, schedule: this.checked(c) }));
    const upserted: string[] = [];
    for (const { c, schedule } of planned) {
      const id = staticCronId(c.key);
      await this.scheduler.upsert(id, c.job, c.payload, schedule);
      upserted.push(id);
    }
    const retired = new Set(retiredCrons().map(staticCronId));
    const removed: string[] = [];
    for (const id of await this.scheduler.listIds(STATIC_PREFIX)) {
      const key = id.slice(STATIC_PREFIX.length);
      if (!retired.has(id) && !disabled.has(cronKeyModule(key))) continue;
      await this.scheduler.remove(id);
      removed.push(id);
    }
    return { upserted, removed };
  }
```

- [ ] **Step 5: Chạy test, typecheck, lint**

Run:
```bash
pnpm vitest run --project unit test/unit/core/config/module-registry.spec.ts test/unit/core/scheduler/static-scheduler.spec.ts
pnpm typecheck
pnpm vitest run --project integration test/integration/core/scheduler/scheduler.spec.ts
pnpm exec prettier --write src/core/config src/core/scheduler test/unit/core/config test/unit/core/scheduler
pnpm lint
```
Expected: unit PASS (2 ca cũ + 3 ca mới + 6 ca registry); `scheduler.spec.ts` (Testcontainers) vẫn xanh, gồm `never removes undeclared static crons implicitly; only retired ones` (hành vi không bật `disable` không đổi); typecheck, lint xanh.

- [ ] **Step 6: Commit**

```bash
git add src/core/config src/core/scheduler test/unit/core/config test/unit/core/scheduler
git commit -m "feat(core): module registry (markModuleLoaded/loadedModules) and removal of static crons of disabled modules"
```

---

### Task 3: `src/boilerplate.modules.ts` + `composeAppModules`; luật chéo module theo tập module bật; `app.modules.ts` top-level await; `markModuleLoaded` ở ba module; `gen-env-example` đọc composition (UP-12, UP-12d)

**Files:**
- Create: `src/boilerplate.modules.ts`, `test/unit/composition/compose.spec.ts`, `test/unit/composition/composition-rules.spec.ts`
- Modify: `src/app.modules.ts`, `src/composition.config.ts`, `src/modules/notifications/index.ts`, `src/modules/identity/index.ts`, `src/modules/tenancy/index.ts`, `src/scripts/gen-env-example.ts`, `test/unit/modules/notifications/retention-outlives-token-ttl-rule.spec.ts`, `.env.example` (sinh lại)
- Modify (chỉ khi Task 1 Step 1 in "4A ĐÃ MERGE"): `src/modules/entitlements/index.ts`

**Interfaces:**
- Consumes: `markModuleLoaded`, `loadedModules` (Task 2, `core/config`); `setDisabledModuleKeys` (Task 2, `core/scheduler`); `NotificationsModule`, `IdentityModule` (SP2), `TenancyModule` (3A Task 19); `defineConfigRule` (SP1).
- Produces (`src/boilerplate.modules.ts`):
  - `type ModuleImport = Type<unknown> | DynamicModule`; `type ModulePair = { api: ModuleImport; worker: ModuleImport }`; `type AppFeatures = { api: ModuleImport[]; worker: ModuleImport[] }`.
  - `type ComposeOptions<K extends string> = { disable?: readonly K[]; features: AppFeatures }` (4A thêm `plans`).
  - `type ModuleEntry<K extends string> = { load: (opts: ComposeOptions<K>) => Promise<ModulePair> }`; `type OptionalBridge<K extends string> = { key: string; when: readonly K[]; load: () => Promise<ModulePair> }`; `type Composition<K extends string> = { modules; requires; bridges; registerRules }`.
  - `BOILERPLATE_MODULES` (`notifications`, `identity`, `tenancy`, đúng thứ tự), `type BoilerplateModuleKey`, `MODULE_REQUIRES` (`notifications → []`, `identity → [notifications]`, `tenancy → [identity]`), `OPTIONAL_BRIDGES: readonly OptionalBridge<BoilerplateModuleKey>[] = []`.
  - `composeFrom<K extends string>(c: Composition<K>, opts: ComposeOptions<K>): Promise<AppFeatures>`; `composeAppModules(opts: ComposeOptions<BoilerplateModuleKey>): Promise<AppFeatures>`.
  - `registerCompositionRules(enabled: ReadonlySet<string>): void` (`src/composition.config.ts`).
  - `APP_MODULES: AppFeatures` (`src/app.modules.ts`, top-level await) — `app-api.module.ts`, `app-worker.module.ts`, `main.*` không đổi.
  - Quy ước dòng `// upstream:template` trong `src/app.modules.ts` (Task 7 `init.mjs` xoá nguyên dòng).

- [ ] **Step 1: Test composition (fail)**

`test/unit/composition/compose.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOILERPLATE_MODULES,
  MODULE_REQUIRES,
  OPTIONAL_BRIDGES,
  composeFrom,
  type Composition,
  type ModulePair,
} from '../../../src/boilerplate.modules.js';
import { markModuleLoaded } from '../../../src/core/config/index.js';
import {
  disabledModuleKeys,
  setDisabledModuleKeys,
} from '../../../src/core/scheduler/index.js';

class Feature {}
const pairOf = (): ModulePair => {
  class Api {}
  class Worker {}
  return { api: Api, worker: Worker };
};

let seq = 0;
/**
 * Composition fixture `a` ← `b` (b cần a) cộng một cầu nối `when: [a, b]`. Mỗi ca một bộ khoá riêng: `markModuleLoaded`
 * là trạng thái toàn process, không reset được giữa các ca.
 */
function fixture(o: { marks?: boolean; bridgeWhen?: string[] } = {}) {
  seq += 1;
  const a = `fa${seq}`;
  const b = `fb${seq}`;
  const pairs = { a: pairOf(), b: pairOf(), bridge: pairOf() };
  const loader = (key: string, pair: ModulePair) =>
    vi.fn(() => {
      if (o.marks !== false) markModuleLoaded(key);
      return Promise.resolve(pair);
    });
  const loads = { a: loader(a, pairs.a), b: loader(b, pairs.b) };
  const bridgeLoad = vi.fn(() => Promise.resolve(pairs.bridge));
  const registerRules = vi.fn();
  const c: Composition<string> = {
    modules: { [a]: { load: loads.a }, [b]: { load: loads.b } },
    requires: { [a]: [], [b]: [a] },
    bridges: [{ key: `br${seq}`, when: o.bridgeWhen ?? [a, b], load: bridgeLoad }],
    registerRules,
  };
  return { a, b, c, pairs, loads, bridgeLoad, registerRules };
}
const noFeatures = { api: [], worker: [] };

describe('composeFrom (spec SP7 §6.2)', () => {
  afterEach(() => setDisabledModuleKeys([]));

  it('loads enabled modules in declaration order, then bridges, then features, into both roles', async () => {
    const f = fixture();
    const r = await composeFrom(f.c, {
      features: { api: [Feature], worker: [Feature] },
    });
    expect(r.api).toEqual([f.pairs.a.api, f.pairs.b.api, f.pairs.bridge.api, Feature]);
    expect(r.worker).toEqual([
      f.pairs.a.worker,
      f.pairs.b.worker,
      f.pairs.bridge.worker,
      Feature,
    ]);
    expect(f.registerRules).toHaveBeenCalledWith(new Set([f.a, f.b]));
    expect(disabledModuleKeys()).toEqual(new Set());
  });

  it('a disabled module is never imported; its bridge neither (UP-12d)', async () => {
    const f = fixture();
    const r = await composeFrom(f.c, { disable: [f.b], features: noFeatures });
    expect(f.loads.b).not.toHaveBeenCalled();
    expect(f.bridgeLoad).not.toHaveBeenCalled();
    expect(r.api).toEqual([f.pairs.a.api]);
    expect(r.worker).toEqual([f.pairs.a.worker]);
    expect(f.registerRules).toHaveBeenCalledWith(new Set([f.a]));
    expect(disabledModuleKeys()).toEqual(new Set([f.b]));
  });

  it('refuses to disable a module that an enabled module requires (UP-12)', async () => {
    const f = fixture();
    await expect(
      composeFrom(f.c, { disable: [f.a], features: noFeatures }),
    ).rejects.toThrow(`Module "${f.b}" requires "${f.a}", which is disabled`);
    expect(f.loads.b).not.toHaveBeenCalled();
  });

  it.each([
    ['a duplicate key', (a: string) => [a, a], /listed twice in disable/],
    ['an unknown key', () => ['nope'], /Unknown module "nope" in disable/],
  ])('refuses %s in disable (UP-12)', async (_name, disableOf, message) => {
    const f = fixture();
    await expect(
      composeFrom(f.c, { disable: disableOf(f.b), features: noFeatures }),
    ).rejects.toThrow(message);
    expect(f.loads.a).not.toHaveBeenCalled();
  });

  it('refuses a bridge that names an unknown module (UP-12)', async () => {
    const f = fixture({ bridgeWhen: ['ghost'] });
    await expect(composeFrom(f.c, { features: noFeatures })).rejects.toThrow(
      /Optional bridge "br\d+" names unknown module "ghost"/,
    );
  });

  it('fails when a disabled module was imported anyway (by a feature or another module)', async () => {
    const f = fixture();
    markModuleLoaded(f.b);
    await expect(
      composeFrom(f.c, { disable: [f.b], features: noFeatures }),
    ).rejects.toThrow(
      `Module "${f.b}" is disabled but was imported (by a feature or another module); enable it or remove the import`,
    );
  });

  it("fails when an enabled module's index.ts does not call markModuleLoaded", async () => {
    const f = fixture({ marks: false });
    await expect(composeFrom(f.c, { features: noFeatures })).rejects.toThrow(
      `Module "${f.a}" was loaded but its index.ts did not call markModuleLoaded('${f.a}')`,
    );
  });
});

describe('boilerplate composition constants', () => {
  it('lists the boilerplate modules in import order, with their requirements and no optional bridge yet (R-X13)', () => {
    expect(Object.keys(BOILERPLATE_MODULES)).toEqual([
      'notifications',
      'identity',
      'tenancy',
    ]);
    expect(MODULE_REQUIRES).toEqual({
      notifications: [],
      identity: ['notifications'],
      tenancy: ['identity'],
    });
    expect(OPTIONAL_BRIDGES).toEqual([]);
  });
});
```
(Nếu Task 1 Step 1 in "4A ĐÃ MERGE", ca cuối kỳ vọng thêm `'entitlements'` sau `'tenancy'` và `entitlements: ['tenancy']` — Step 6.)

`test/unit/composition/composition-rules.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { configRuleRegistry } from '../../../src/core/config/config.registry.js';
import { registerCompositionRules } from '../../../src/composition.config.js';

const RULE = 'notifications-retention-outlives-token-ttl';

describe('cross-module config rules follow the enabled set (spec SP7 §6.2, C1)', () => {
  it('registers nothing when only one side of a rule is enabled', () => {
    registerCompositionRules(new Set(['identity']));
    registerCompositionRules(new Set(['notifications']));
    expect(configRuleRegistry().map((r) => r.name)).not.toContain(RULE);
  });
  it('registers the retention rule once both identity and notifications are enabled', () => {
    registerCompositionRules(new Set(['notifications', 'identity', 'tenancy']));
    expect(configRuleRegistry().map((r) => r.name)).toContain(RULE);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/composition`
Expected: FAIL — `Cannot find module '../../../src/boilerplate.modules.js'`, `registerCompositionRules` không export.

- [ ] **Step 3: `src/composition.config.ts` theo tập module bật**

Bỏ hai dòng `import './modules/identity/index.js';` và `import './modules/notifications/index.js';`. Giữ nguyên hằng và toàn bộ chú thích N7; thêm vào cuối chú thích một đoạn:
```ts
 *
 * SP7 7A (§6.2, C1): file này không còn import module nào; `composeAppModules` gọi `registerCompositionRules` với tập
 * module đang bật, và luật chỉ đăng ký khi CẢ HAI module của nó bật (tắt một bên thì namespace của bên đó không tồn
 * tại, luật sẽ báo sai). Luật chéo module của SP sau đăng ký theo cùng mẫu: điều kiện là tập module của nó.
```
Bọc lời gọi `defineConfigRule(...)` hiện có (thân luật giữ nguyên từng dòng) trong hàm export:
```ts
export function registerCompositionRules(enabled: ReadonlySet<string>): void {
  if (enabled.has('identity') && enabled.has('notifications'))
    defineConfigRule('notifications-retention-outlives-token-ttl', (c) => {
      // …thân luật hiện có, không đổi…
    });
}
```
(Thân luật là khối từ `const retentionDays = c.notifications?.retentionDays;` tới `…(AUTH_EMAIL_TOKEN_TTL_SEC/AUTH_RESET_TOKEN_TTL_SEC, ${maxTtlSec}s)\`;` của file hiện tại; chép nguyên, chỉ thụt lề.)

`test/unit/modules/notifications/retention-outlives-token-ttl-rule.spec.ts` — thay dòng `import '../../../../src/composition.config.js';` (và chú thích N7 ngay trên nó) bằng:
```ts
// N7 + SP7 7A: luật chéo module đăng ký qua composition, chỉ khi cả identity lẫn notifications bật.
import { registerCompositionRules } from '../../../../src/composition.config.js';
```
và thêm ngay sau khối import:
```ts
registerCompositionRules(new Set(['identity', 'notifications']));
```

- [ ] **Step 4: `src/boilerplate.modules.ts`**

```ts
import type { DynamicModule, Type } from '@nestjs/common';
import { registerCompositionRules } from './composition.config.js';
import { loadedModules } from './core/config/index.js';
import { setDisabledModuleKeys } from './core/scheduler/index.js';

export type ModuleImport = Type<unknown> | DynamicModule;
export type ModulePair = { api: ModuleImport; worker: ModuleImport };
export type AppFeatures = { api: ModuleImport[]; worker: ModuleImport[] };
export type ComposeOptions<K extends string> = {
  /** Module nền dự án không dùng: không bao giờ được import, nên config, luật, queue, job, cron của nó không đăng ký. */
  disable?: readonly K[];
  features: AppFeatures;
};
export type ModuleEntry<K extends string> = {
  load: (opts: ComposeOptions<K>) => Promise<ModulePair>;
};
/** Cầu nối nạp khi MỌI module trong `when` cùng bật (R-X13). Không có config/queue/job/cron, không gọi markModuleLoaded. */
export type OptionalBridge<K extends string> = {
  key: string;
  when: readonly K[];
  load: () => Promise<ModulePair>;
};
export type Composition<K extends string> = {
  modules: Readonly<Record<K, ModuleEntry<K>>>;
  requires: Readonly<Record<K, readonly K[]>>;
  bridges: readonly OptionalBridge<K>[];
  registerRules: (enabled: ReadonlySet<K>) => void;
};

/**
 * Module nền của boilerplate (vùng boilerplate, spec SP7 §6.2, S7-D7). Mỗi mục là một loader: import một module là
 * đăng ký trạng thái toàn cục của nó, nên module bị tắt chỉ thật sự tắt khi không bao giờ được import. Thứ tự là thứ
 * tự import có nghĩa (module sau có thể dùng cổng của module trước). Module của SP sau thêm mục của mình ở đây, cùng
 * dòng `MODULE_REQUIRES` và `markModuleLoaded('<m>')` ở dòng đầu `index.ts` (R-X16).
 */
export const BOILERPLATE_MODULES = {
  notifications: {
    load: async () => {
      const m = await import('./modules/notifications/index.js');
      return {
        api: m.NotificationsModule.forApi(),
        worker: m.NotificationsModule.forWorker(),
      };
    },
  },
  identity: {
    load: async () => {
      const m = await import('./modules/identity/index.js');
      return {
        api: m.IdentityModule.forApi(),
        worker: m.IdentityModule.forWorker(),
      };
    },
  },
  tenancy: {
    load: async () => {
      const m = await import('./modules/tenancy/index.js');
      return {
        api: m.TenancyModule.forApi(),
        worker: m.TenancyModule.forWorker(),
      };
    },
  },
} as const satisfies Record<string, ModuleEntry<string>>;

export type BoilerplateModuleKey = keyof typeof BOILERPLATE_MODULES;

/** Module bật thì mọi module nó cần phải bật (spec SP7 §6.2 bước 1). */
export const MODULE_REQUIRES = {
  notifications: [],
  identity: ['notifications'],
  tenancy: ['identity'],
} as const satisfies Record<BoilerplateModuleKey, readonly BoilerplateModuleKey[]>;

/** Cầu nối tuỳ chọn (R-X13). Rỗng ở 7A; SP4 4B thêm dòng `entitlements-files`. Entry của cầu nối chỉ import từ đây. */
export const OPTIONAL_BRIDGES: readonly OptionalBridge<BoilerplateModuleKey>[] =
  [];

/**
 * Dựng danh sách module của hai vai trò (spec SP7 §6.2, các bước 1–5). Export để test chạy với composition fixture
 * (UP-12b, UP-12d); ứng dụng chỉ gọi `composeAppModules`.
 */
export async function composeFrom<K extends string>(
  c: Composition<K>,
  opts: ComposeOptions<K>,
): Promise<AppFeatures> {
  const isKey = (k: string): k is K => Object.hasOwn(c.modules, k);
  const keys = Object.keys(c.modules).filter(isKey);
  // 1. Kiểm tra trước khi import bất cứ gì.
  const disabled = new Set<K>();
  for (const k of opts.disable ?? []) {
    if (!isKey(k))
      throw new Error(
        `Unknown module "${k}" in disable; known modules: ${keys.join(', ')}`,
      );
    if (disabled.has(k))
      throw new Error(`Module "${k}" is listed twice in disable`);
    disabled.add(k);
  }
  const enabled = new Set(keys.filter((k) => !disabled.has(k)));
  for (const k of enabled)
    for (const r of c.requires[k]) {
      if (!isKey(r))
        throw new Error(`Module "${k}" requires unknown module "${r}"`);
      if (!enabled.has(r))
        throw new Error(
          `Module "${k}" requires "${r}", which is disabled; disable "${k}" too or enable "${r}"`,
        );
    }
  const bridgeKeys = new Set<string>();
  for (const b of c.bridges) {
    if (bridgeKeys.has(b.key))
      throw new Error(`Optional bridge "${b.key}" is defined twice`);
    bridgeKeys.add(b.key);
    for (const w of b.when)
      if (!isKey(w))
        throw new Error(
          `Optional bridge "${b.key}" names unknown module "${w}"`,
        );
  }
  // 2. Module đang bật, tuần tự theo thứ tự khai báo; 2b. cầu nối có đủ module của nó.
  const api: ModuleImport[] = [];
  const worker: ModuleImport[] = [];
  for (const k of keys) {
    if (!enabled.has(k)) continue;
    const pair = await c.modules[k].load(opts);
    api.push(pair.api);
    worker.push(pair.worker);
  }
  for (const b of c.bridges) {
    if (!b.when.every((w) => enabled.has(w))) continue;
    const pair = await b.load();
    api.push(pair.api);
    worker.push(pair.worker);
  }
  // 3. Luật config chéo module theo tập module bật.
  c.registerRules(enabled);
  // 4. Không module tắt nào đã bị import; mọi module bật đã tự đánh dấu.
  const loaded = loadedModules();
  for (const m of loaded)
    if (isKey(m) && !enabled.has(m))
      throw new Error(
        `Module "${m}" is disabled but was imported (by a feature or another module); enable it or remove the import`,
      );
  for (const k of enabled)
    if (!loaded.has(k))
      throw new Error(
        `Module "${k}" was loaded but its index.ts did not call markModuleLoaded('${k}')`,
      );
  // 5. Cron tĩnh của module tắt sẽ được StaticScheduler gỡ.
  setDisabledModuleKeys([...disabled]);
  return {
    api: [...api, ...opts.features.api],
    worker: [...worker, ...opts.features.worker],
  };
}

/** Composition của ứng dụng: module nền của boilerplate + cầu nối + feature của dự án. */
export function composeAppModules(
  opts: ComposeOptions<BoilerplateModuleKey>,
): Promise<AppFeatures> {
  return composeFrom<BoilerplateModuleKey>(
    {
      modules: BOILERPLATE_MODULES,
      requires: MODULE_REQUIRES,
      bridges: OPTIONAL_BRIDGES,
      registerRules: registerCompositionRules,
    },
    opts,
  );
}
```

- [ ] **Step 5: `markModuleLoaded` ở dòng đầu ba module, `app.modules.ts`, `gen-env-example.ts`**

Đầu `src/modules/notifications/index.ts`, `src/modules/identity/index.ts`, `src/modules/tenancy/index.ts` (trước mọi dòng `export`), với `<m>` lần lượt `notifications`, `identity`, `tenancy`:
```ts
import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('<m>');
```
`src/app.modules.ts` — thay toàn bộ nội dung:
```ts
import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';

/**
 * Composition của dự án (vùng dự án, file hạt giống của upstream; spec SP7 §6.2). `disable`: khoá module nền không
 * dùng (module bị tắt không bao giờ được import). Feature của dự án: thêm một dòng
 * `features.api.push(XModule.forApi());` và một dòng `features.worker.push(XModule.forWorker());`.
 * Dòng kết thúc bằng `// upstream:template` thuộc vùng template: `pnpm upstream:init` xoá nguyên dòng đó.
 * Top-level await: ESM đánh giá xong file này trước khi `main.*` gọi `validateAllConfigs()`.
 */
const features: AppFeatures = { api: [], worker: [] };

export const APP_MODULES = await composeAppModules({ disable: [], features });
```
`src/scripts/gen-env-example.ts` — bỏ các dòng `import '../modules/notifications/notifications.config.js';`, `import '../modules/identity/identity.config.js';`, `import '../modules/tenancy/tenancy.config.js';`; thêm ngay sau `import '../core/config/all-configs.js';`:
```ts
// SP7 7A (C2 của SP2 §5.15): config của đúng các module đang bật trong composition của dự án, kể cả feature;
// module bị tắt không có dòng nào.
import '../app.modules.js';
```

- [ ] **Step 6: Chỉ khi 4A đã merge trước 7A (amendment D1, X-7)**

Nếu Task 1 Step 1 in "4A ĐÃ MERGE": đối chiếu tên thật trong `src/modules/entitlements/index.ts` và `src/plans.example.ts` (`EntitlementsModule.forApi(plans)`, `type PlanCatalogue`, catalogue gói export từ `plans.example.ts`), rồi:
1. Dòng đầu `src/modules/entitlements/index.ts`: cùng khối `markModuleLoaded('entitlements')` như Step 5 (xoá bản `markModuleLoaded` nào 4A đã thêm nếu trùng).
2. `src/boilerplate.modules.ts`: thêm `import type { PlanCatalogue } from './modules/entitlements/index.js';` (bị xoá lúc biên dịch), trường `plans?: PlanCatalogue` vào `ComposeOptions`, mục `entitlements` sau `tenancy`, dòng `entitlements: ['tenancy']` trong `MODULE_REQUIRES`, và kiểm thiếu `plans` trong `composeAppModules` trước khi gọi `composeFrom`:
```ts
  entitlements: {
    load: async (o: ComposeOptions<string>) => {
      const m = await import('./modules/entitlements/index.js');
      if (!o.plans)
        throw new Error(
          'composeAppModules: "plans" is required while entitlements is enabled (docs/boilerplate/README.md "Nâng cấp lên SP4")',
        );
      return {
        api: m.EntitlementsModule.forApi(o.plans),
        worker: m.EntitlementsModule.forWorker(o.plans),
      };
    },
  },
```
```ts
  if (!(opts.disable ?? []).includes('entitlements') && !opts.plans)
    throw new Error(
      'composeAppModules: "plans" is required while entitlements is enabled (docs/boilerplate/README.md "Nâng cấp lên SP4")',
    );
```
3. `src/app.modules.ts`: thêm `import { <tên catalogue 4A export> } from './plans.example.js';` và `plans: <tên đó>` vào lời gọi `composeAppModules` (dòng import giữ đường dẫn `./plans.example.js`: `init.mjs` đổi nó thành `./app.plans.js`).
4. `test/unit/composition/compose.spec.ts` ca cuối: kỳ vọng thêm `'entitlements'` và `entitlements: ['tenancy']`; thêm ca `composeAppModules({ features })` thiếu `plans` → ném `"plans" is required while entitlements is enabled`.
Nếu 4A chưa merge: bỏ qua bước này (4A làm phần tương ứng, SP4 §6 "Composition").

- [ ] **Step 7: Chạy test, kiểm composition thật, sinh lại `.env.example`**

Run:
```bash
pnpm vitest run --project unit test/unit/composition test/unit/modules/notifications/retention-outlives-token-ttl-rule.spec.ts
pnpm typecheck
pnpm arch
pnpm env:example && git diff --stat .env.example .env.infra.example
pnpm build && pnpm openapi:export && git diff --exit-code openapi.json
node --input-type=module -e "const { loadedModules } = await import('./dist/core/config/index.js'); await import('./dist/app.modules.js'); console.log(JSON.stringify([...loadedModules()]))"
pnpm test
pnpm vitest run --project integration test/e2e/core/entrypoints.e2e.spec.ts
```
Expected:
- unit composition PASS (8 ca `composeFrom` + 1 hằng + 2 luật), ca luật retention cũ PASS;
- `pnpm arch` sạch (không vòng import: `composition.config.ts` không import `boilerplate.modules.ts`; loader là `import()` tới `index.ts`);
- `.env.example`: không thêm/bớt dòng env nào so với trước (có thể chỉ đổi thứ tự khối namespace nếu thứ tự import đổi); có dòng thêm/bớt → dừng, tìm module nào đăng ký config khác trước;
- `openapi.json` không đổi;
- dòng node in `["notifications","identity","tenancy"]`;
- toàn bộ `pnpm test` và e2e entrypoints xanh.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/boilerplate.modules.ts src/app.modules.ts src/composition.config.ts src/modules/notifications/index.ts src/modules/identity/index.ts src/modules/tenancy/index.ts src/scripts/gen-env-example.ts test/unit/composition test/unit/modules/notifications/retention-outlives-token-ttl-rule.spec.ts
pnpm lint
git add src/boilerplate.modules.ts src/app.modules.ts src/composition.config.ts src/modules src/scripts/gen-env-example.ts test/unit/composition test/unit/modules/notifications/retention-outlives-token-ttl-rule.spec.ts .env.example .env.infra.example
git commit -m "feat(composition): lazy module composition (composeAppModules, MODULE_REQUIRES, empty OPTIONAL_BRIDGES) with markModuleLoaded and cross-module rules per enabled set"
```

---
### Task 4: Tắt module thật sự tắt nó (UP-12b, R7-17), module chỉ đăng ký cron của mình và chỉ import thứ nó khai (UP-12c); kiểm chứng prod-like #1 (composition trên image production)

**Files:**
- Create: `test/fixtures/composition/fixturemod/index.ts`, `test/fixtures/composition/tenancy-importing-feature.ts`, `test/support/composition-probe.ts`, `test/support/composition-feature-probe.ts`, `test/support/composition-worker-entry.ts`, `test/integration/composition/module-isolation.spec.ts`, `test/integration/composition/disable-module.spec.ts`, `test/smoke/composition.smoke.spec.ts`

**Interfaces:**
- Consumes: `composeFrom`, `composeAppModules`, `BOILERPLATE_MODULES`, `MODULE_REQUIRES`, `type Composition` (Task 3); `markModuleLoaded`, `loadedModules`, `defineConfig`, `defineConfigRule`, `configRegistry`, `renderEnvExample` (`core/config`); `configRuleRegistry` (`core/config/config.registry.ts`); `cronRegistry` (`core/scheduler/cron-definition.ts`); `JobScheduler`, `JobHandler`, `MaintenanceQueue`, `defineJob`, `defineQueue`, `queueRegistry` (`core/queue`); `defineCron` (`core/scheduler`); `AppWorkerModule`, `bootstrapWorker`, `installShutdown` (SP1); `startAppProcess`/`stopAppProcess`/`AppProcess` (`test/support/app-process.ts`), `baseTestEnv` (`test/support/env.ts`), `isSignalRelay` (`test/support/spawn-worker.ts`); smoke `compose`, `logsSince` (`test/smoke/smoke-support.ts`).
- Produces: module fixture `fixturemod` (config bắt buộc `FIXTUREMOD_REQUIRED`, queue `fixturemod`, job `fixturemod.work`, cron `fixturemod.tick` ở `maintenance`, luật `fixturemod-rule`); probe in một dòng JSON; smoke composition cho Task 12.

- [ ] **Step 1: Module fixture và các entry probe**

`test/fixtures/composition/fixturemod/index.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import {
  defineConfig,
  markModuleLoaded,
} from '../../../../src/core/config/index.js';
import {
  JobHandler,
  MaintenanceQueue,
  defineJob,
  defineQueue,
} from '../../../../src/core/queue/index.js';
import { defineCron } from '../../../../src/core/scheduler/index.js';

/**
 * Module nền giả cho UP-12b (spec SP7 §19): có đủ mọi thứ mà "tắt module" phải gỡ — config bắt buộc, queue riêng có job,
 * cron tĩnh (job ở `maintenance` theo quy ước S7-D34) và một luật chéo module (đăng ký bởi composition fixture).
 */
markModuleLoaded('fixturemod');

export const fixturemodConfig = defineConfig(
  'fixturemod',
  { required: 'FIXTUREMOD_REQUIRED' },
  z.object({
    required: z
      .string()
      .min(1)
      .describe('Required env of the composition fixture module'),
  }),
);
export const FixturemodQueue = defineQueue('fixturemod', { kind: 'io' });
export const FixturemodWorkJob = defineJob({
  name: 'fixturemod.work',
  queue: FixturemodQueue,
  version: 1,
  schema: z.object({}),
});
export const FixturemodTickJob = defineJob({
  name: 'fixturemod.tick',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'fixturemod.tick',
  job: FixturemodTickJob,
  payload: {},
  schedule: () => ({ cron: '0 0 1 1 *', tz: 'UTC' }),
});

@Injectable()
@JobHandler(FixturemodWorkJob)
class WorkHandler {
  handle(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@JobHandler(FixturemodTickJob)
class TickHandler {
  handle(): Promise<void> {
    return Promise.resolve();
  }
}

@Module({ providers: [WorkHandler, TickHandler] })
export class FixturemodModule {}
```
`test/fixtures/composition/tenancy-importing-feature.ts`:
```ts
// UP-12c: một "feature" import tĩnh index của tenancy; khi tenancy bị tắt, composition phải từ chối và nêu tên module.
import '../../../src/modules/tenancy/index.js';
```
`test/support/composition-probe.ts`:
```ts
/**
 * UP-12c (spec SP7 §19): nạp riêng một mục của BOILERPLATE_MODULES trong process này (sau khi đã nạp các module nó
 * cần theo MODULE_REQUIRES) rồi in một dòng JSON: module nào đã được đánh dấu và cron nào mới được đăng ký.
 * Chạy: `node --import @swc-node/register/esm-register test/support/composition-probe.ts <module>`.
 */
import {
  BOILERPLATE_MODULES,
  MODULE_REQUIRES,
  type BoilerplateModuleKey,
  type Composition,
} from '../../src/boilerplate.modules.js';
import { loadedModules } from '../../src/core/config/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';

const modules: Composition<BoilerplateModuleKey>['modules'] =
  BOILERPLATE_MODULES;
const isKey = (k: string): k is BoilerplateModuleKey =>
  Object.hasOwn(BOILERPLATE_MODULES, k);
const key = process.argv[2] ?? '';
if (!isKey(key)) throw new Error(`composition-probe: unknown module "${key}"`);

const requires = new Set<BoilerplateModuleKey>();
const visit = (k: BoilerplateModuleKey): void => {
  for (const r of MODULE_REQUIRES[k])
    if (!requires.has(r)) {
      requires.add(r);
      visit(r);
    }
};
visit(key);
const noFeatures = { features: { api: [], worker: [] } };
for (const k of Object.keys(BOILERPLATE_MODULES).filter(isKey))
  if (requires.has(k)) await modules[k].load(noFeatures);
const before = new Set(cronRegistry().map((c) => c.key));
const loadedBefore = [...loadedModules()];
await modules[key].load(noFeatures);
const result = {
  key,
  requires: [...requires],
  loadedBefore,
  loaded: [...loadedModules()],
  newCrons: cronRegistry()
    .map((c) => c.key)
    .filter((k) => !before.has(k)),
};
// Thoát tường minh sau khi stdout xả xong: module có thể giữ handle (không cần cho probe).
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
```
`test/support/composition-feature-probe.ts`:
```ts
/** UP-12c: feature import tĩnh index của tenancy trong khi tenancy bị tắt → composeAppModules phải ném, nêu tên module. */
import '../fixtures/composition/tenancy-importing-feature.js';
import { composeAppModules } from '../../src/boilerplate.modules.js';

let result: { error: string } | { ok: true };
try {
  await composeAppModules({
    disable: ['tenancy'],
    features: { api: [], worker: [] },
  });
  result = { ok: true };
} catch (err) {
  result = { error: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
```
`test/support/composition-worker-entry.ts`:
```ts
/**
 * UP-12b: worker thật (`bootstrapWorker` + `AppWorkerModule`) cộng module fixture `fixturemod` nạp qua `composeFrom`.
 * `COMPOSITION_FIXTURE_DISABLE=fixturemod` tắt nó. Sau khi boot (StaticScheduler đã sync), in một dòng
 * `COMPOSITION_PROBE <json>` rồi báo `{ ready: true }` qua IPC (test/support/app-process.ts).
 */
import { Module } from '@nestjs/common';
import { AppWorkerModule } from '../../src/app-worker.module.js';
import { composeFrom } from '../../src/boilerplate.modules.js';
import { configRuleRegistry } from '../../src/core/config/config.registry.js';
import {
  configRegistry,
  defineConfigRule,
  renderEnvExample,
} from '../../src/core/config/index.js';
import { JobScheduler, queueRegistry } from '../../src/core/queue/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';
import { bootstrapWorker } from '../../src/main.worker.js';
import { installShutdown } from '../../src/shutdown.js';
import { isSignalRelay } from './spawn-worker.js';

const disable: 'fixturemod'[] =
  process.env.COMPOSITION_FIXTURE_DISABLE === 'fixturemod'
    ? ['fixturemod']
    : [];
const fixture = await composeFrom<'fixturemod'>(
  {
    modules: {
      fixturemod: {
        load: async () => {
          const m = await import('../fixtures/composition/fixturemod/index.js');
          return { api: m.FixturemodModule, worker: m.FixturemodModule };
        },
      },
    },
    requires: { fixturemod: [] },
    bridges: [],
    registerRules: (enabled) => {
      if (enabled.has('fixturemod'))
        defineConfigRule('fixturemod-rule', () => undefined);
    },
  },
  { disable, features: { api: [], worker: [] } },
);

@Module({ imports: [AppWorkerModule, ...fixture.worker] })
class CompositionWorkerModule {}

const ctx = await bootstrapWorker(CompositionWorkerModule);
installShutdown(ctx);
process.on('message', (m: unknown) => {
  if (isSignalRelay(m)) process.emit(m.signal, m.signal);
});
const probe = {
  queues: queueRegistry().map((q) => q.name),
  crons: cronRegistry().map((c) => c.key),
  namespaces: configRegistry().map((e) => e.namespace),
  rules: configRuleRegistry().map((r) => r.name),
  envExampleHasFixture: renderEnvExample(configRegistry()).includes(
    'FIXTUREMOD_',
  ),
  schedulers: await ctx.get(JobScheduler).listIds('static-'),
};
process.stdout.write(`COMPOSITION_PROBE ${JSON.stringify(probe)}\n`);
process.send?.({ ready: true });
```

- [ ] **Step 2: Test UP-12c và UP-12b**

`test/integration/composition/module-isolation.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BOILERPLATE_MODULES } from '../../../src/boilerplate.modules.js';
import { baseTestEnv } from '../../support/env.js';

const TS_LOADER = ['--import', '@swc-node/register/esm-register'];
/** Nạp TS qua swc (lạnh) và import cả cây module: rộng hơn nhiều so với thực tế. */
const PROBE_TIMEOUT_MS = 90_000;
const Probe = z.object({
  key: z.string(),
  requires: z.array(z.string()),
  loadedBefore: z.array(z.string()),
  loaded: z.array(z.string()),
  newCrons: z.array(z.string()),
});
const lastJsonLine = (entry: string, args: string[]): unknown => {
  const out = execFileSync(process.execPath, [...TS_LOADER, entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...baseTestEnv() },
    timeout: PROBE_TIMEOUT_MS,
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '');
};

describe('each boilerplate module registers only its own crons and imports only what MODULE_REQUIRES declares (UP-12c)', { timeout: PROBE_TIMEOUT_MS * 2 }, () => {
  it.each(Object.keys(BOILERPLATE_MODULES))('%s', (key) => {
    const r = Probe.parse(
      lastJsonLine('test/support/composition-probe.ts', [key]),
    );
    expect(r.loadedBefore, 'a required module imports this one').not.toContain(key);
    expect(r.loaded, 'index.ts must call markModuleLoaded').toContain(key);
    expect(
      r.loaded.filter((m) => m !== key && !r.requires.includes(m)),
      'imported modules missing from MODULE_REQUIRES',
    ).toEqual([]);
    expect(
      r.newCrons.filter((c) => !c.startsWith(`${key}.`) && !c.startsWith('core.')),
      `crons of "${key}" must be keyed "${key}.*"`,
    ).toEqual([]);
  });

  it('a feature that statically imports a disabled module stops the composition, naming the module', () => {
    expect(lastJsonLine('test/support/composition-feature-probe.ts', [])).toEqual({
      error:
        'Module "tenancy" is disabled but was imported (by a feature or another module); enable it or remove the import',
    });
  });
});
```
`test/integration/composition/disable-module.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';

const ENTRY = 'test/support/composition-worker-entry.ts';
const MARKER = 'COMPOSITION_PROBE ';
const CRON_ID = 'static-fixturemod.tick';
const Probe = z.object({
  queues: z.array(z.string()),
  crons: z.array(z.string()),
  namespaces: z.array(z.string()),
  rules: z.array(z.string()),
  envExampleHasFixture: z.boolean(),
  schedulers: z.array(z.string()),
});
const probeOf = (p: AppProcess) => {
  const line = p
    .output()
    .split('\n')
    .find((l) => l.startsWith(MARKER));
  if (!line) throw new Error(`no ${MARKER}line in worker output:\n${p.output()}`);
  return Probe.parse(JSON.parse(line.slice(MARKER.length)));
};

describe('disabling a module really disables it (UP-12b, spec SP7 §6.2, R7-17)', () => {
  let worker: AppProcess | undefined;
  afterEach(async () => {
    await stopAppProcess(worker);
    worker = undefined;
  });
  const boot = async (env: Record<string, string>) => {
    await stopAppProcess(worker);
    worker = await startAppProcess(ENTRY, { ...baseTestEnv(), ...env });
    return probeOf(worker);
  };

  it('enable → disable → re-enable', async () => {
    // Pha 1: bật. Mọi thứ của module có mặt, cron đã đồng bộ lên Redis.
    const on = await boot({ FIXTUREMOD_REQUIRED: 'x' });
    expect(on.queues).toContain('fixturemod');
    expect(on.crons).toContain('fixturemod.tick');
    expect(on.namespaces).toContain('fixturemod');
    expect(on.rules).toContain('fixturemod-rule');
    expect(on.envExampleHasFixture).toBe(true);
    expect(on.schedulers).toContain(CRON_ID);

    // Pha 2: tắt, KHÔNG có env bắt buộc của nó. Worker vẫn boot (không lỗi config, không lỗi
    // "Jobs on consumed queues have no @JobHandler"), không còn gì của module, cron đã đồng bộ trước đó bị gỡ.
    const off = await boot({ COMPOSITION_FIXTURE_DISABLE: 'fixturemod' });
    expect(off.queues).not.toContain('fixturemod');
    expect(off.crons).not.toContain('fixturemod.tick');
    expect(off.namespaces).not.toContain('fixturemod');
    expect(off.rules).not.toContain('fixturemod-rule');
    expect(off.envExampleHasFixture).toBe(false);
    expect(off.schedulers).not.toContain(CRON_ID);
    expect(off.schedulers).toEqual(
      expect.arrayContaining(['static-identity.purge-expired', 'static-tenancy.orgs.purge']),
    );

    // Pha 3 (Review Focus 4): bật lại → cron được đồng bộ lại.
    const again = await boot({ FIXTUREMOD_REQUIRED: 'x' });
    expect(again.schedulers).toContain(CRON_ID);
  });
});
```

- [ ] **Step 3: Cho thấy RED bằng đột biến tạm, rồi hoàn tác**

Test viết sau code của Task 3, nên RED bằng đột biến có hoàn tác:
```bash
# (a) bỏ bước 5 của composition → cron của module tắt không bị gỡ
sed -i 's/^  setDisabledModuleKeys(\[\.\.\.disabled\]);$/  void disabled;/' src/boilerplate.modules.ts
pnpm vitest run --project integration test/integration/composition/disable-module.spec.ts
git checkout -- src/boilerplate.modules.ts
# (b) bỏ markModuleLoaded của tenancy → UP-12c đỏ
sed -i "s/^markModuleLoaded('tenancy');$//" src/modules/tenancy/index.ts
pnpm vitest run --project integration test/integration/composition/module-isolation.spec.ts
git checkout -- src/modules/tenancy/index.ts
git status --short
```
Expected: (a) FAIL ở `expect(off.schedulers).not.toContain(CRON_ID)` (cron của module tắt còn trong Redis); (b) hai FAIL: ca `tenancy` (`index.ts must call markModuleLoaded`: `loaded` thiếu `tenancy`) và ca feature (probe in `{ "ok": true }`: tenancy bị import nhưng không tự đánh dấu nên bước 4 không thấy nó — đúng lỗ mà nghĩa vụ `markModuleLoaded` bịt). Sau hai `git checkout` cây chỉ còn các file mới của task (untracked).

- [ ] **Step 4: Chạy xanh**

Run: `pnpm vitest run --project integration test/integration/composition`
Expected: PASS — UP-12c: 3 ca module (`notifications`, `identity`, `tenancy`) + ca feature; UP-12b: một ca ba pha. Ca `identity` cho thấy `requires = ['notifications']`, `newCrons` toàn `identity.*` (cộng `core.*` nếu module import barrel core lần đầu).

- [ ] **Step 5: Smoke prod-like #1 — composition trên image production**

`test/smoke/composition.smoke.spec.ts`:
```ts
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { compose, logsSince } from './smoke-support.js';

/** Chạy trong container worker (ENTRYPOINT distroless là node): import composition của `dist/` bằng top-level await. */
const LOADED_MODULES_SCRIPT = [
  "const { loadedModules } = await import('./dist/core/config/index.js');",
  "await import('./dist/app.modules.js');",
  'process.stdout.write(JSON.stringify([...loadedModules()]));',
].join(' ');
const COMPOSE_RUN_TIMEOUT_MS = 60_000;
const StaticSync = z.object({
  upserted: z.array(z.string()),
  removed: z.array(z.string()),
});
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    // Dòng không phải JSON (không phải log pino): không phải dòng cần tìm.
    return undefined;
  }
};

describe('prod-like smoke: composition (SP7 7A)', () => {
  const { startedAt } = inject('smoke');

  it('dist/app.modules.js composes with top-level await on the production image and loads exactly the enabled modules', () => {
    const out = compose(
      ['run', '--rm', '--no-deps', 'worker', '--input-type=module', '-e', LOADED_MODULES_SCRIPT],
      { timeoutMs: COMPOSE_RUN_TIMEOUT_MS },
    );
    expect(
      z.array(z.string()).parse(JSON.parse(out.trim().split('\n').at(-1) ?? '')),
    ).toEqual(['notifications', 'identity', 'tenancy']);
  });

  it('the worker synced the static crons of every enabled module and removed none', () => {
    const syncs = logsSince(startedAt)
      .split('\n')
      .flatMap((line) => {
        const r = StaticSync.safeParse(jsonOf(line));
        return r.success ? [r.data] : [];
      });
    expect(syncs.length).toBeGreaterThan(0);
    for (const s of syncs) {
      expect(s.upserted).toEqual(
        expect.arrayContaining([
          'static-core.outbox.cleanup',
          'static-notifications.purge-deliveries',
          'static-identity.purge-expired',
          'static-tenancy.orgs.purge',
        ]),
      );
      expect(s.removed).toEqual([]);
    }
  });
});
```
(Nếu 4A đã merge và `entitlements` có trong composition, ca đầu kỳ vọng thêm `'entitlements'` ở cuối.)

Run: `pnpm build && pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer), migrate; mọi file smoke PASS (`core`, `auth-email`, `dashboard`, `tenancy`, `composition`); log api/worker JSON, không `error`; teardown `down -v` sạch.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write test/fixtures/composition test/support/composition-probe.ts test/support/composition-feature-probe.ts test/support/composition-worker-entry.ts test/integration/composition test/smoke/composition.smoke.spec.ts
pnpm lint && pnpm typecheck
git add test/fixtures/composition test/support/composition-probe.ts test/support/composition-feature-probe.ts test/support/composition-worker-entry.ts test/integration/composition test/smoke/composition.smoke.spec.ts
git commit -m "test(composition): disabled modules register nothing and lose their synced crons (UP-12b), modules register only their own crons (UP-12c), composition smoke on the production image"
```

---

## Phần C — Điểm mở rộng cho dự án (spec §6.1 M5, S7-D28, S7-D31)

### Task 5: Inventory chuẩn hoá nạp bằng glob; `.dependency-cruiser.app.cjs`; thứ tự migration theo vùng (amendment B1); migration upstream cũ hơn migration dự án vẫn chạy (UP-10, cơ chế)

**Files:**
- Create: `test/support/feature-inventory.ts`, `test/unit/support/feature-inventory.spec.ts`, `test/support/migration-zones.ts`, `test/unit/migrations/migration-zones.spec.ts`, `test/unit/architecture/app-rules-hook.spec.ts`, `test/integration/upstream/out-of-order-migrations.spec.ts`
- Modify: `test/integration/core/database/normalization-inventory.spec.ts`, `test/unit/migrations/migration-order.spec.ts`, `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: `runMigrations`, `type MigrationObject` (`core/database`), `coreMigrationList` (`test/support/migrate-test-db.ts`), `createScratchDb` (`test/support/scratch-db.ts`), `applyTestEnv` (`test/support/app-factory.ts`), `Migration` (`@mikro-orm/migrations`).
- Produces:
  - `type NormalizationEntry = { table: string; columns: readonly string[] }`, `type FeatureInventory = { tables?; globalTables?; definerFunctions?; definerReadTables? }`, `parseFeatureInventory(file: string, mod: unknown): FeatureInventory`, `mergeAnalysedColumns(base, inventories): Record<string, readonly string[]>` (`test/support/feature-inventory.ts`; 7D dùng thêm cho `rls-catalog.spec.ts`).
  - `migrationZone(path: string): 'app' | 'boilerplate'`, `migrationsNotNewerThanZone(onMain: readonly string[], added: readonly string[]): string[]` (`test/support/migration-zones.ts`).
  - `.dependency-cruiser.cjs` nạp `forbidden` của `.dependency-cruiser.app.cjs` nếu file tồn tại; tên luật trùng → ném.

- [ ] **Step 1: Test (fail)**

`test/unit/support/feature-inventory.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  mergeAnalysedColumns,
  parseFeatureInventory,
} from '../../support/feature-inventory.js';

const BASE = { 'public.organizations': ['id', 'name'] } as const;

describe('feature inventories (spec SP7 S7-D28)', () => {
  it('without inventories the boilerplate constant is unchanged', () => {
    expect(mergeAnalysedColumns(BASE, {})).toEqual(BASE);
  });
  it('adds the tables a project inventory declares', () => {
    const merged = mergeAnalysedColumns(BASE, {
      'test/integration/features/crm/crm.inventory.ts': {
        tables: [{ table: 'public.crm_leads', columns: ['id', 'org_id'] }],
      },
    });
    expect(merged['public.crm_leads']).toEqual(['id', 'org_id']);
    expect(merged['public.organizations']).toEqual(['id', 'name']);
  });
  it('refuses a table declared twice (boilerplate or another inventory)', () => {
    expect(() =>
      mergeAnalysedColumns(BASE, {
        'a.inventory.ts': {
          tables: [{ table: 'public.organizations', columns: ['id'] }],
        },
      }),
    ).toThrow('a.inventory.ts: table public.organizations is already in the normalization inventory');
  });
  it.each([
    ['a misspelled export', { table: [] }],
    ['an unqualified table name', { tables: [{ table: 'crm_leads', columns: ['id'] }] }],
    ['no column', { tables: [{ table: 'public.crm_leads', columns: [] }] }],
    ['a duplicate column', { tables: [{ table: 'public.crm_leads', columns: ['id', 'id'] }] }],
  ])('refuses %s', (_name, mod) => {
    expect(() => parseFeatureInventory('x.inventory.ts', mod)).toThrow(/^x\.inventory\.ts: /);
  });
});
```
`test/unit/migrations/migration-zones.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  migrationZone,
  migrationsNotNewerThanZone,
} from '../../support/migration-zones.js';

const M = (dir: string, ts: string) => `src/migrations/${dir}/Migration${ts}_x.ts`;

describe('migration order per zone (spec SP7 S7-D31, amendment B1)', () => {
  it('classifies app/ as the project zone and everything else (example/ included) as boilerplate', () => {
    expect(migrationZone(M('app', '20270101000000'))).toBe('app');
    expect(migrationZone('src\\migrations\\app\\Migration20270101000000_x.ts')).toBe('app');
    expect(migrationZone(M('tenancy', '20260101000000'))).toBe('boilerplate');
    expect(migrationZone(M('example', '20260101000000'))).toBe('boilerplate');
  });
  it('an upstream migration older than project migrations is fine; each zone is compared with itself', () => {
    const onMain = [M('core', '20260101000000'), M('app', '20270601000000')];
    expect(
      migrationsNotNewerThanZone(onMain, [M('tenancy', '20260201000000'), M('app', '20270701000000')]),
    ).toEqual([]);
  });
  it('reports an added migration that is not newer than its own zone on main', () => {
    const onMain = [M('core', '20260301000000'), M('app', '20270601000000')];
    expect(
      migrationsNotNewerThanZone(onMain, [M('tenancy', '20260201000000'), M('app', '20270501000000')]),
    ).toEqual([M('tenancy', '20260201000000'), M('app', '20270501000000')]);
  });
});
```
`test/unit/architecture/app-rules-hook.spec.ts`:
```ts
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IConfiguration } from 'dependency-cruiser';
import { afterEach, describe, expect, it } from 'vitest';

const APP_RULE = `module.exports = { forbidden: [{ name: 'app-crm-not-billing', severity: 'error', from: { path: '^src/features/crm/' }, to: { path: '^src/features/billing-ui/' } }] };\n`;
let dir: string | undefined;
function loadConfig(appRules?: string): IConfiguration {
  dir = mkdtempSync(join(tmpdir(), 'nsb-depcruise-'));
  copyFileSync('.dependency-cruiser.cjs', join(dir, '.dependency-cruiser.cjs'));
  if (appRules) writeFileSync(join(dir, '.dependency-cruiser.app.cjs'), appRules);
  const require = createRequire(join(dir, 'x.cjs'));
  return require('./.dependency-cruiser.cjs') as IConfiguration;
}
const names = (c: IConfiguration) => (c.forbidden ?? []).map((r) => r.name);

describe('.dependency-cruiser.app.cjs extension point (spec SP7 §6.1, M5)', () => {
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  it('without the project file the boilerplate rules are unchanged', () => {
    expect(names(loadConfig())).not.toContain('app-crm-not-billing');
  });
  it("appends the project's forbidden rules", () => {
    const base = names(loadConfig()).length;
    rmSync(dir ?? '', { recursive: true, force: true });
    const withApp = names(loadConfig(APP_RULE));
    expect(withApp).toContain('app-crm-not-billing');
    expect(withApp.length).toBe(base + 1);
  });
  it('refuses a project rule that reuses a boilerplate rule name', () => {
    expect(() =>
      loadConfig(`module.exports = { forbidden: [{ name: 'no-circular', from: {}, to: {} }] };\n`),
    ).toThrow('.dependency-cruiser.app.cjs: rule "no-circular" already exists in the boilerplate rules');
  });
  it('refuses a project file without a forbidden array', () => {
    expect(() => loadConfig('module.exports = {};\n')).toThrow(
      '.dependency-cruiser.app.cjs must export { forbidden: [...] }',
    );
  });
});
```
(`require(...) as IConfiguration`: `require` trả `any` theo kiểu của `NodeRequire`; phép gán kiểu này là cách `rules.spec.ts` đang dùng (`const config: IConfiguration = require(...)`), không phải cast `never`/`any`. Nếu oxlint báo, đổi sang dạng khai báo biến có kiểu như `rules.spec.ts`.)

`test/integration/upstream/out-of-order-migrations.spec.ts`:
```ts
import { Migration } from '@mikro-orm/migrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import {
  createScratchDb,
  type ScratchDb,
} from '../../support/scratch-db.js';

/** Migration của dự án (vùng `app/`) có timestamp mới hơn mọi migration boilerplate (spec SP7 S7-D31). */
class Migration20991231235959_app_fixture_newer extends Migration {
  override name = 'Migration20991231235959_app_fixture_newer';
  override up(): void | Promise<void> {
    this.addSql('SELECT 1');
  }
  override down(): void | Promise<void> {
    this.addSql('SELECT 1');
  }
}
const APP_NEWER: MigrationObject = {
  name: Migration20991231235959_app_fixture_newer.name,
  class: Migration20991231235959_app_fixture_newer,
};

describe('an upstream migration older than the project migrations still runs (UP-10, S7-D31, MikroORM getPending)', () => {
  applyTestEnv();
  const core = coreMigrationList();
  const lateUpstream = core.at(-1);
  let scratch: ScratchDb;
  beforeAll(async () => {
    if (!lateUpstream) throw new Error('no core migration found');
    scratch = await createScratchDb('upgrade_order');
    vi.stubEnv('DB_NAME', scratch.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await scratch?.drop();
  });

  it('runs the older upstream migration after the newer project migration, and nothing stays pending', async () => {
    const before = { kind: 'list' as const, list: [...core.slice(0, -1), APP_NEWER] };
    const after = { kind: 'list' as const, list: [...core, APP_NEWER] };
    await runMigrations('up', { source: before });
    expect(await runMigrations('status', { source: after })).toEqual([lateUpstream?.name]);
    expect(await runMigrations('up', { source: after })).toEqual([lateUpstream?.name]);
    expect(await runMigrations('status', { source: after })).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run:
```bash
pnpm vitest run --project unit test/unit/support/feature-inventory.spec.ts test/unit/migrations/migration-zones.spec.ts test/unit/architecture/app-rules-hook.spec.ts
pnpm vitest run --project integration test/integration/upstream/out-of-order-migrations.spec.ts
```
Expected: unit FAIL (`Cannot find module '../../support/feature-inventory.js'`, `…/migration-zones.js`; hook: `app-crm-not-billing` không có). Integration: **PASS ngay** — đây là kiểm chứng hành vi của MikroORM 7.2.1 (spec đã đọc code `AbstractMigrator.js:56-63`), không phải code mới; ghi output vào báo cáo task. Nếu FAIL (`status` rỗng hoặc migrator ném vì thứ tự) → **dừng**, báo Sếp: S7-D31 sai, quy trình sync phải đổi.

- [ ] **Step 3: Cài đặt**

`test/support/feature-inventory.ts`:
```ts
import { z } from 'zod';

/** Một bảng đã phân tích chuẩn hoá: `schema.bảng` và đúng tập cột (spec SP2 §5.16, SP3 §6.12). */
export type NormalizationEntry = { table: string; columns: readonly string[] };
/**
 * Khai báo của một feature dự án ở `test/integration/features/<f>/<f>.inventory.ts` (spec SP7 S7-D28): test của
 * boilerplate gộp khai báo này vào hằng của mình, nên dự án thêm bảng mà không sửa file test của boilerplate.
 */
export type FeatureInventory = {
  tables?: readonly NormalizationEntry[];
  globalTables?: readonly string[];
  definerFunctions?: readonly string[];
  definerReadTables?: readonly string[];
};

const QUALIFIED_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const Inventory = z
  .object({
    tables: z
      .array(
        z.object({
          table: z.string().regex(QUALIFIED_TABLE, 'table must be schema.table'),
          columns: z
            .array(z.string().min(1))
            .min(1)
            .refine((c) => new Set(c).size === c.length, 'duplicate column'),
        }),
      )
      .optional(),
    globalTables: z.array(z.string().min(1)).optional(),
    definerFunctions: z.array(z.string().min(1)).optional(),
    definerReadTables: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function parseFeatureInventory(file: string, mod: unknown): FeatureInventory {
  const r = Inventory.safeParse(mod);
  if (!r.success)
    throw new Error(
      `${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
    );
  return r.data;
}

export function mergeAnalysedColumns(
  base: Readonly<Record<string, readonly string[]>>,
  inventories: Readonly<Record<string, unknown>>,
): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...base };
  for (const [file, mod] of Object.entries(inventories))
    for (const t of parseFeatureInventory(file, mod).tables ?? []) {
      if (Object.hasOwn(merged, t.table))
        throw new Error(
          `${file}: table ${t.table} is already in the normalization inventory`,
        );
      merged[t.table] = t.columns;
    }
  return merged;
}
```
(Module namespace object của ES có khoá `Symbol.toStringTag`; zod `.strict()` chỉ xét khoá chuỗi, nên export lạ khác bốn tên trên bị từ chối còn symbol thì không.)

`test/integration/core/database/normalization-inventory.spec.ts` — thêm import và dùng hằng đã gộp:
```ts
import { mergeAnalysedColumns } from '../../../support/feature-inventory.js';
```
Ngay sau khai báo `ANALYSED_COLUMNS`:
```ts
/**
 * Bảng của feature dự án (spec SP7 S7-D28): mỗi `test/**/features/**/*.inventory.ts` export `tables`, gộp vào hằng
 * của boilerplate; trùng bảng thì fail. Ở upstream chưa có file nào (mẫu SP7 thêm ở 7D).
 */
const ALL_ANALYSED_COLUMNS = mergeAnalysedColumns(
  ANALYSED_COLUMNS,
  import.meta.glob<Record<string, unknown>>('../../../**/features/**/*.inventory.ts', {
    eager: true,
  }),
);
```
và đổi `it.each(Object.entries(ANALYSED_COLUMNS))` thành `it.each(Object.entries(ALL_ANALYSED_COLUMNS))`.

`test/support/migration-zones.ts`:
```ts
import { basename } from 'node:path';

const APP_MIGRATIONS = 'src/migrations/app/';
const STAMP = /^Migration(\d{14})_/;

/** Vùng của một migration (spec SP7 S7-D31): `app/` của dự án; mọi thư mục khác (kể cả `example/`) là boilerplate. */
export const migrationZone = (path: string): 'app' | 'boilerplate' =>
  path.replaceAll('\\', '/').startsWith(APP_MIGRATIONS) ? 'app' : 'boilerplate';

const stampOf = (path: string): string => {
  const m = STAMP.exec(basename(path.replaceAll('\\', '/')));
  if (!m?.[1]) throw new Error(`${path} does not follow Migration<14 digits>_<name>.ts`);
  return m[1];
};

/**
 * Migration mới của nhánh không mới hơn migration mới nhất CÙNG VÙNG trên main (amendment B1): migration upstream đến
 * muộn với timestamp cũ hơn migration của dự án là hợp lệ (MikroORM chạy mọi migration chưa chạy, UP-10).
 */
export function migrationsNotNewerThanZone(
  onMain: readonly string[],
  added: readonly string[],
): string[] {
  const newest = (zone: 'app' | 'boilerplate') =>
    onMain.filter((f) => migrationZone(f) === zone).map(stampOf).sort().at(-1) ?? '';
  return added.filter((f) => !(stampOf(f) > newest(migrationZone(f))));
}
```
`test/unit/migrations/migration-order.spec.ts` — import và ca cuối:
```ts
import { migrationsNotNewerThanZone } from '../../support/migration-zones.js';
```
Thay tên ca `every migration added on this branch is newer than the newest migration on ${MAIN}` bằng `every migration added on this branch is newer than the newest migration of its zone on ${MAIN} (SP7 S7-D31)`; giữ nguyên phần tính `base`, `onMain`, `added`; thay hai dòng `const newest = …` và vòng `for (const f of added) expect(…)` bằng:
```ts
    expect(migrationsNotNewerThanZone(onMain, added)).toEqual([]);
```

`.dependency-cruiser.cjs`:
- Dòng 2 `module.exports = {` → `const config = {`.
- Sau `};` đóng object (trước dòng chú thích `// generated: dependency-cruiser@18.4.0 …`), thêm:
```js

/**
 * Điểm mở rộng của dự án (spec SP7 §6.1, M5): luật kiến trúc riêng nằm ở `.dependency-cruiser.app.cjs` (vùng dự án),
 * export `{ forbidden: [...] }`, được nối sau luật của boilerplate. File này thuộc vùng boilerplate: không sửa ở clone.
 */
const APP_RULES_FILE = require('node:path').join(
  __dirname,
  '.dependency-cruiser.app.cjs',
);
if (require('node:fs').existsSync(APP_RULES_FILE)) {
  const app = require(APP_RULES_FILE);
  if (!Array.isArray(app?.forbidden))
    throw new Error('.dependency-cruiser.app.cjs must export { forbidden: [...] }');
  const known = new Set(config.forbidden.map((r) => r.name));
  for (const rule of app.forbidden)
    if (known.has(rule.name))
      throw new Error(
        `.dependency-cruiser.app.cjs: rule "${rule.name}" already exists in the boilerplate rules`,
      );
  config.forbidden.push(...app.forbidden);
}

module.exports = config;
```

- [ ] **Step 4: Chạy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/support test/unit/migrations test/unit/architecture
pnpm vitest run --project integration test/integration/core/database/normalization-inventory.spec.ts test/integration/upstream/out-of-order-migrations.spec.ts
pnpm arch
```
Expected: unit PASS (4 + 3 + 4 ca mới; `migration-order.spec.ts` cũ vẫn xanh; `rules.spec.ts` vẫn bắt mọi fixture và cây `src` sạch); normalization inventory xanh với đúng số bảng như trước (không file inventory nào); UP-10 xanh; `pnpm arch` sạch.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write .dependency-cruiser.cjs test/support/feature-inventory.ts test/support/migration-zones.ts test/unit/support test/unit/migrations test/unit/architecture/app-rules-hook.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/upstream
pnpm lint && pnpm typecheck
git add .dependency-cruiser.cjs test/support/feature-inventory.ts test/support/migration-zones.ts test/unit/support test/unit/migrations test/unit/architecture/app-rules-hook.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/upstream
git commit -m "feat(upstream): project extension points (feature inventories, .dependency-cruiser.app.cjs, migration order per zone) and prove out-of-order upstream migrations run"
```

---
## Phần D — Quy trình upstream (spec §6.1, §6.3.4, §8.2, §13)

### Task 6: `.upstream/zones.json` + `tools/upstream/check.mjs` (so cây với commit upstream, kiểm theo khoá, `--self`, `--rev`); repo git tạm cho test; `--self` (UP-9)

**Files:**
- Create: `.upstream/zones.json`, `tools/upstream/check.mjs`, `test/support/upstream-fixture.ts`, `test/unit/upstream/self.spec.ts` (test trên clone, UP-1…UP-5, cần `init.mjs` nên nằm ở Task 7)
- Modify: `package.json` (script `upstream:check`)

**Interfaces:**
- Consumes: git ≥ 2.28 trên PATH; Node 24.
- Produces:
  - `.upstream/zones.json` `{ version: 1, boilerplate, project, template, generated, shared, projectSeed }` (mảng tiền tố: kết thúc `/` = thư mục, kết thúc `*` = tiền tố chuỗi, còn lại = đúng path; tiền tố dài nhất thắng; không khớp = dự án).
  - `node tools/upstream/check.mjs [--rev <commit>] [--self]`: exit 0 + `upstream:check OK (<rev|self>)`; exit 1 + một dòng `<path>: <loại vi phạm>` mỗi vi phạm rồi `upstream:check found <n> violation(s)`; lỗi cấu hình (version.json/zones.json sai, commit không có, squash) → `upstream:check: <thông điệp>` exit 1. Chạy được từ stdin (`git show <commit>:tools/upstream/check.mjs | node --input-type=module -`).
  - `test/support/upstream-fixture.ts`: `class Repo { dir; git(...args): string; gitRaw(...args): { status; stdout; stderr }; write(path, content); read(path); exists(path); remove(path); commitAll(message): string; tool(name: 'check' | 'sync' | 'init', args?: string[], input?: string): ToolResult }`, `createUpstream(): Repo` (tag `v0.1.0`), `releaseUpstream(up: Repo, tag: string, o: { write?: Record<string, string>; remove?: string[]; notes?: string }): string`, `cloneAtTag(up: Repo, tag: string): Repo` (remote `upstream`, nhánh `main`), `initProject(up: Repo, tag?: string): Repo` (clone + `init.mjs` + commit), `removeRepo(r: Repo | undefined): void`, `FIXTURE_APP_MODULES`, `FIXTURE_APP_MODULES_AFTER_INIT`.
  - Script `"upstream:check": "node tools/upstream/check.mjs"`.

- [ ] **Step 1: `.upstream/zones.json` (nguồn sự thật của vùng, spec 6.1)**

```json
{
  "version": 1,
  "boilerplate": [
    "src/core/",
    "src/modules/",
    "src/migrations/",
    "src/main.api.ts",
    "src/main.worker.ts",
    "src/main.migrate.ts",
    "src/app-api.module.ts",
    "src/app-worker.module.ts",
    "src/boilerplate.modules.ts",
    "src/composition.config.ts",
    "src/instrumentation.ts",
    "src/shutdown.ts",
    "src/scripts/",
    "src/types/",
    "test/",
    "docker/",
    "Dockerfile",
    "compose.yaml",
    "deploy/helm/",
    "deploy/policy/",
    "deploy/tools.env",
    "docs/adr/",
    "docs/boilerplate/",
    "docs/runbooks/",
    "docs/upstream/",
    "docs/superpowers/",
    "tools/",
    ".upstream/zones.json",
    ".github/workflows/ci.yml",
    ".github/workflows/nightly.yml",
    ".github/workflows/release.yml",
    ".github/workflows/upstream-guard.yml",
    ".github/workflows/release-please.yml",
    ".github/codeql/",
    "CHANGELOG.md",
    "version.txt",
    "release-please-config.json",
    ".release-please-manifest.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "nest-cli.json",
    ".swcrc",
    "vitest.config.ts",
    ".oxlintrc.json",
    ".prettierrc",
    ".prettierignore",
    ".dependency-cruiser.cjs",
    "mikro-orm.config.ts",
    ".nvmrc",
    ".gitattributes",
    ".pnpmfile.mjs",
    ".auth-schema/"
  ],
  "project": [
    "src/features/",
    "src/app.modules.ts",
    "src/app.plans.ts",
    "src/migrations/app/",
    "src/types/app/",
    "test/unit/features/",
    "test/integration/features/",
    "test/e2e/features/",
    "deploy/values/",
    "docs/app/",
    "docs/adr/app/",
    "docs/runbooks/app/",
    ".github/workflows/app-*",
    ".github/CODEOWNERS",
    ".dependency-cruiser.app.cjs",
    "README.md",
    "compose.override.yaml",
    ".upstream/version.json"
  ],
  "template": [
    "src/features/example/",
    "src/migrations/example/",
    "src/plans.example.ts",
    "test/unit/features/example/",
    "test/integration/features/example/",
    "test/e2e/features/example/",
    "deploy/values/example.yaml"
  ],
  "generated": [".env.example", ".env.infra.example", "openapi.json", "pnpm-lock.yaml"],
  "shared": [
    "package.json",
    "pnpm-workspace.yaml",
    "renovate.json",
    ".gitignore",
    ".dockerignore",
    ".gitleaksignore"
  ],
  "projectSeed": ["src/app.modules.ts", "README.md"]
}
```
(`version.txt` thêm vào danh sách boilerplate của spec 6.1: đó là tệp version của release-please `simple`, spike S7A-2; spec 13.6 đã nói nó thuộc vùng boilerplate.)

- [ ] **Step 2: Helper repo tạm `test/support/upstream-fixture.ts`**

```ts
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** File thật của repo được chép vào upstream fixture: bộ công cụ và vùng đúng như sẽ ship. */
const COPIED_FROM_REPO = [
  '.upstream/zones.json',
  'tools/upstream/check.mjs',
  'tools/upstream/sync.mjs',
  'tools/upstream/init.mjs',
  'docs/upstream/CODEOWNERS.template',
] as const;
const REPO_ROOT = process.cwd();
const RM_RETRIES = 5;

/** `src/app.modules.ts` của upstream fixture: dòng template theo quy ước `// upstream:template` (Task 3). */
export const FIXTURE_APP_MODULES = [
  "import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';",
  "import { ExampleModule } from './features/example/index.js'; // upstream:template",
  "import { examplePlans } from './plans.example.js';",
  '',
  'const features: AppFeatures = { api: [], worker: [] };',
  'features.api.push(ExampleModule.forApi()); // upstream:template',
  'features.worker.push(ExampleModule.forWorker()); // upstream:template',
  '',
  'export const APP_MODULES = await composeAppModules({ disable: [], plans: examplePlans, features });',
  '',
].join('\n');
export const FIXTURE_APP_MODULES_AFTER_INIT = [
  "import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';",
  "import { examplePlans } from './app.plans.js';",
  '',
  'const features: AppFeatures = { api: [], worker: [] };',
  '',
  'export const APP_MODULES = await composeAppModules({ disable: [], plans: examplePlans, features });',
  '',
].join('\n');

const FIXTURE_FILES: Record<string, string> = {
  'src/core/x.ts': 'export const x = 1;\n',
  'src/app.modules.ts': FIXTURE_APP_MODULES,
  'src/features/example/example.ts': 'export const example = 1;\n',
  'src/plans.example.ts': "export const examplePlans = { defaultPlan: 'free' };\n",
  'src/migrations/example/Migration20260101000000_starter_plans.ts':
    'export class Migration20260101000000_starter_plans {\n  override name = "Migration20260101000000_starter_plans";\n}\n',
  'README.md': '# Boilerplate\n',
  'CHANGELOG.md': '# Changelog\n\n## 0.1.0 (2026-09-29)\n\n### Upgrade notes\n\n- first release\n',
  'package.json': `${JSON.stringify(
    {
      name: 'boilerplate-fixture',
      version: '0.0.1',
      private: true,
      scripts: {
        'upstream:regenerate': 'node tools/fixture/regenerate.mjs',
        'upstream:verify': 'node tools/fixture/verify.mjs',
      },
      dependencies: { zod: '4.6.5' },
    },
    null,
    2,
  )}\n`,
  'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\nallowBuilds:\n  esbuild: true\n',
  '.env.example': 'A=1\n',
  'tools/fixture/regenerate.mjs':
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('.env.example', 'REGENERATED=1\\n');\n",
  'tools/fixture/verify.mjs': 'process.exitCode = 0;\n',
  'docs/superpowers/ghi chú.md': 'upstream history\n',
};

export type ToolResult = { status: number | null; stdout: string; stderr: string };

export class Repo {
  constructor(readonly dir: string) {}
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' }).trim();
  }
  gitRaw(...args: string[]): ToolResult {
    const r = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }
  read(path: string): string {
    return readFileSync(join(this.dir, path), 'utf8');
  }
  exists(path: string): boolean {
    return existsSync(join(this.dir, path));
  }
  remove(path: string): void {
    unlinkSync(join(this.dir, path));
  }
  commitAll(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
  tool(name: 'check' | 'sync' | 'init', args: string[] = [], input?: string): ToolResult {
    const r = spawnSync(
      process.execPath,
      [join(this.dir, 'tools', 'upstream', `${name}.mjs`), ...args],
      { cwd: this.dir, encoding: 'utf8', input },
    );
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
}

function configure(r: Repo): Repo {
  r.git('config', 'user.name', 'Fixture');
  r.git('config', 'user.email', 'fixture@example.test');
  r.git('config', 'core.autocrlf', 'false');
  r.git('config', 'commit.gpgsign', 'false');
  return r;
}

export function createUpstream(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'nsb-upstream-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const up = configure(new Repo(dir));
  // init.mjs, sync.mjs và CODEOWNERS.template có từ Task 7–8; test của mỗi task chỉ dùng công cụ đã có.
  for (const p of COPIED_FROM_REPO)
    if (existsSync(join(REPO_ROOT, p)))
      up.write(p, readFileSync(join(REPO_ROOT, p), 'utf8'));
  for (const [p, c] of Object.entries(FIXTURE_FILES)) up.write(p, c);
  up.commitAll('feat: boilerplate v0.1.0');
  up.git('tag', 'v0.1.0');
  return up;
}

/** Một bản phát hành upstream: đổi file, thêm mục CHANGELOG (kèm "Upgrade notes" nếu có), commit, gắn tag. */
export function releaseUpstream(
  up: Repo,
  tag: string,
  o: { write?: Record<string, string>; remove?: string[]; notes?: string } = {},
): string {
  for (const [p, c] of Object.entries(o.write ?? {})) up.write(p, c);
  for (const p of o.remove ?? []) up.remove(p);
  const notes = o.notes ? `\n### Upgrade notes\n\n- ${o.notes}\n` : '';
  up.write('CHANGELOG.md', up.read('CHANGELOG.md').replace('# Changelog\n', `# Changelog\n\n## ${tag.slice(1)} (2026-10-01)\n${notes}`));
  const sha = up.commitAll(`feat: boilerplate ${tag}`);
  up.git('tag', tag);
  return sha;
}

export function cloneAtTag(up: Repo, tag: string): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'nsb-clone-'));
  execFileSync('git', ['clone', '-q', '--branch', tag, up.dir, dir]);
  const r = configure(new Repo(dir));
  r.git('switch', '-q', '-C', 'main');
  r.git('remote', 'rename', 'origin', 'upstream');
  return r;
}

/** Clone ở `tag`, chạy `init.mjs`, commit: trạng thái của một dự án vừa khởi tạo. */
export function initProject(up: Repo, tag = 'v0.1.0'): Repo {
  const r = cloneAtTag(up, tag);
  const res = r.tool('init', ['--team-core', '@acme/platform', '--team-app', '@acme/app']);
  if (res.status !== 0) throw new Error(`init failed (${res.status}):\n${res.stdout}${res.stderr}`);
  r.commitAll(`chore: initialize project from boilerplate ${tag}`);
  return r;
}

export function removeRepo(r: Repo | undefined): void {
  if (r) rmSync(r.dir, { recursive: true, force: true, maxRetries: RM_RETRIES });
}
```

- [ ] **Step 3: Test `--self` (fail)**

`test/unit/upstream/self.spec.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUpstream, removeRepo, type Repo } from '../../support/upstream-fixture.js';

const GIT_CASE_TIMEOUT_MS = 60_000;

describe('upstream:check --self (UP-9)', { timeout: GIT_CASE_TIMEOUT_MS }, () => {
  // Chỉ ở repo upstream: một clone (có `.upstream/version.json`) track file vùng dự án ngoài hạt giống là bình thường,
  // và guard của clone chạy ở workflow upstream-guard. Nhờ vậy `pnpm test` của boilerplate xanh ở mọi clone (UP-13).
  it.skipIf(existsSync('.upstream/version.json'))('every file tracked by this repository is zoned, and only seed files are in the project zone', () => {
    // `--rev HEAD`: kiểm cây đã commit như CI, không in cảnh báo "uncommitted" khi máy dev đang có thay đổi.
    const r = spawnSync(
      process.execPath,
      ['tools/upstream/check.mjs', '--self', '--rev', 'HEAD'],
      { encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  describe('on an upstream fixture', () => {
    let up: Repo;
    beforeEach(() => {
      up = createUpstream();
    });
    afterEach(() => removeRepo(up));

    it('passes as created', () => {
      expect(up.tool('check', ['--self']).status).toBe(0);
    });
    it('fails on an unzoned file and on project-zone files outside projectSeed', () => {
      up.write('stray.txt', 'x\n');
      up.write('src/app.plans.ts', 'export const appPlans = {};\n');
      up.write('src/migrations/app/Migration20270101000000_x.ts', 'export {};\n');
      up.commitAll('chore: stray files');
      const r = up.tool('check', ['--self']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('stray.txt: is not classified by .upstream/zones.json');
      expect(r.stderr).toContain('src/app.plans.ts: is in the project zone but not in projectSeed; upstream must not track it');
      expect(r.stderr).toContain('src/migrations/app/Migration20270101000000_x.ts: is in the project zone but not in projectSeed');
    });
  });
});
```


- [ ] **Step 4: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/upstream/self.spec.ts`
Expected: FAIL 3/3 — `Cannot find module …/tools/upstream/check.mjs` (ca repo thật) và `ENOENT` khi fixture chạy `tools/upstream/check.mjs` (hai ca fixture; helper chỉ chép file đã có).

- [ ] **Step 5: `tools/upstream/check.mjs` và script**


```js
// Guard vùng sở hữu (spec SP7 §13.2, §13.3). MỘT file, chỉ node:*, không import tương đối: chạy được từ stdin,
//   git show <commit>:tools/upstream/check.mjs | node --input-type=module -
// để bản ở HEAD (vùng boilerplate) không tự nới luật được. Dùng:
//   node tools/upstream/check.mjs [--rev <commit>]   clone: so HEAD (hoặc <commit>) với commit upstream đã ghi
//   node tools/upstream/check.mjs --self             repo upstream: mọi file được track đều được phân vùng (UP-9)
import { execFileSync, spawnSync } from 'node:child_process';

const TAG = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const ZONE_NAMES = ['boilerplate', 'project', 'template', 'generated', 'shared'];
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const PACKAGE_FILE = 'package.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const PACKAGE_DEP_KEYS = ['dependencies', 'devDependencies'];
const PACKAGE_EQUAL_KEYS = ['type', 'packageManager', 'engines', 'pnpm'];
const PROJECT_SCRIPT_PREFIX = 'app:';
const UPSTREAM_DOCS_PREFIX = 'docs/superpowers/';
const PROJECT_DOCS_HINT =
  'project documents belong in docs/app/; docs/superpowers/ is upstream history';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

class CheckError extends Error {}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function gitExit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (r.error) throw r.error;
  return r;
}
const pathExists = (rev, path) => gitExit(['cat-file', '-e', `${rev}:${path}`]).status === 0;
function isAncestor(ancestor, rev) {
  const r = gitExit(['merge-base', '--is-ancestor', ancestor, rev]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new CheckError(`git merge-base --is-ancestor failed: ${r.stderr.trim()}`);
}

/** path → { mode, oid } của cây ở `rev`; `-z` để path có khoảng trắng/ký tự ngoài ASCII không bị quote. */
function lsTree(rev) {
  const map = new Map();
  for (const rec of git(['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), { mode, oid });
  }
  return map;
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CheckError(`${source}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

function matches(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}
const weight = (pattern) => (pattern.endsWith('*') ? pattern.length - 1 : pattern.length);
/** Tiền tố dài nhất thắng; không khớp mục nào → vùng dự án (không tường minh). */
function zoneOf(zones, path) {
  let best;
  for (const e of zones.entries)
    if (matches(e.pattern, path) && (!best || weight(e.pattern) > weight(best.pattern))) best = e;
  return best ? { zone: best.zone, explicit: true } : { zone: 'project', explicit: false };
}

function parseZones(text, source) {
  const z = parseJson(text, source);
  if (z?.version !== 1) throw new CheckError(`${source}: "version" must be 1`);
  const entries = [];
  const owner = new Map();
  for (const zone of ZONE_NAMES) {
    const list = z[zone];
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || p === ''))
      throw new CheckError(`${source}: "${zone}" must be an array of non-empty strings`);
    for (const pattern of list) {
      if (owner.has(pattern))
        throw new CheckError(`${source}: "${pattern}" is listed in both ${owner.get(pattern)} and ${zone}`);
      owner.set(pattern, zone);
      entries.push({ pattern, zone });
    }
  }
  const zones = { entries, projectSeed: new Set() };
  if (!Array.isArray(z.projectSeed)) throw new CheckError(`${source}: "projectSeed" must be an array`);
  for (const seed of z.projectSeed) {
    const at = zoneOf(zones, seed);
    if (!at.explicit || at.zone !== 'project')
      throw new CheckError(`${source}: projectSeed "${seed}" is not an explicit project-zone path`);
    zones.projectSeed.add(seed);
  }
  return zones;
}

function readVersion(rev) {
  if (!pathExists(rev, VERSION_FILE))
    throw new CheckError(
      `${VERSION_FILE} is missing at ${rev}; a clone creates it with pnpm upstream:init, the upstream repository runs --self`,
    );
  const v = parseJson(git(['show', `${rev}:${VERSION_FILE}`]), VERSION_FILE);
  if (typeof v?.tag !== 'string' || !TAG.test(v.tag))
    throw new CheckError(`${VERSION_FILE}: "tag" must look like vX.Y.Z`);
  if (typeof v.commit !== 'string' || !SHA.test(v.commit))
    throw new CheckError(`${VERSION_FILE}: "commit" must be a full 40-character lowercase commit SHA`);
  return v;
}

const showText = (rev, path) => (pathExists(rev, path) ? git(['show', `${rev}:${path}`]) : undefined);

function checkPackageJson(upstream, rev, out) {
  const upText = showText(upstream, PACKAGE_FILE);
  if (upText === undefined) return;
  const headText = showText(rev, PACKAGE_FILE);
  if (headText === undefined) return out.push({ path: PACKAGE_FILE, kind: 'deleted (shared zone)' });
  const up = parseJson(upText, `${PACKAGE_FILE}@upstream`);
  const head = parseJson(headText, PACKAGE_FILE);
  for (const key of PACKAGE_DEP_KEYS)
    for (const [name, spec] of Object.entries(up[key] ?? {}))
      if (head[key]?.[name] !== spec)
        out.push({
          path: PACKAGE_FILE,
          kind: `${key}.${name} must stay ${spec} (upstream), found ${head[key]?.[name] ?? 'nothing'}`,
        });
  const upScripts = up.scripts ?? {};
  for (const [name, command] of Object.entries(upScripts))
    if (head.scripts?.[name] !== command)
      out.push({ path: PACKAGE_FILE, kind: `scripts.${name} must stay as upstream` });
  for (const name of Object.keys(head.scripts ?? {}))
    if (!Object.hasOwn(upScripts, name) && !name.startsWith(PROJECT_SCRIPT_PREFIX))
      out.push({
        path: PACKAGE_FILE,
        kind: `scripts.${name}: project scripts must start with "${PROJECT_SCRIPT_PREFIX}"`,
      });
  for (const key of PACKAGE_EQUAL_KEYS)
    if (JSON.stringify(up[key]) !== JSON.stringify(head[key]))
      out.push({ path: PACKAGE_FILE, kind: `${key} must equal upstream` });
}

/** Mỗi dòng không phải chú thích, gắn với khoá cấp một chứa nó ("khoá␀dòng"). */
function workspaceLines(text) {
  const out = new Set();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const body = line.trim();
    if (body === '' || body.startsWith('#')) continue;
    if (!/^\s/.test(line)) section = body;
    out.add(`${section}\u0000${body}`);
  }
  return out;
}
function checkWorkspace(upstream, rev, out) {
  const upText = showText(upstream, WORKSPACE_FILE);
  if (upText === undefined) return;
  const head = workspaceLines(showText(rev, WORKSPACE_FILE) ?? '');
  for (const entry of workspaceLines(upText))
    if (!head.has(entry))
      out.push({
        path: WORKSPACE_FILE,
        kind: `upstream line "${entry.split('\u0000')[1]}" is missing or changed`,
      });
}

function checkClone(rev) {
  const version = readVersion(rev);
  if (gitExit(['cat-file', '-e', `${version.commit}^{commit}`]).status !== 0)
    throw new CheckError(
      `upstream commit ${version.commit} (${version.tag}) is not in this repository; fetch full history (actions/checkout fetch-depth: 0)`,
    );
  if (!isAncestor(version.commit, rev))
    throw new CheckError(
      `upstream commit ${version.commit} (${version.tag}) is not in history (squash-merged sync PR?); see docs/upstream/merge.md "Khôi phục sau squash"`,
    );
  const zones = parseZones(git(['show', `${version.commit}:${ZONES_FILE}`]), `${ZONES_FILE}@${version.tag}`);
  const up = lsTree(version.commit);
  const head = lsTree(rev);
  const out = [];
  for (const path of new Set([...up.keys(), ...head.keys()])) {
    const { zone } = zoneOf(zones, path);
    const u = up.get(path);
    const h = head.get(path);
    const same = u && h && u.oid === h.oid && u.mode === h.mode;
    if (zone === 'boilerplate') {
      if (!u) out.push({ path, kind: 'added in the boilerplate zone' });
      else if (!h) out.push({ path, kind: 'deleted from the boilerplate zone' });
      else if (!same) out.push({ path, kind: 'modified in the boilerplate zone' });
    } else if (zone === 'template' && h) {
      if (!u) out.push({ path, kind: 'added in the template zone' });
      else if (!same) out.push({ path, kind: 'modified in the template zone (delete it instead)' });
    }
  }
  checkPackageJson(version.commit, rev, out);
  checkWorkspace(version.commit, rev, out);
  return out;
}

function checkSelf(rev) {
  const zones = parseZones(git(['show', `${rev}:${ZONES_FILE}`]), ZONES_FILE);
  const out = [];
  for (const path of lsTree(rev).keys()) {
    const { zone, explicit } = zoneOf(zones, path);
    if (!explicit) out.push({ path, kind: 'is not classified by .upstream/zones.json' });
    else if (zone === 'project' && !zones.projectSeed.has(path))
      out.push({ path, kind: 'is in the project zone but not in projectSeed; upstream must not track it' });
  }
  return out;
}

function parseArgs(argv) {
  const opts = { rev: 'HEAD', self: false, revGiven: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self') opts.self = true;
    else if (a === '--rev') {
      const value = argv[i + 1];
      if (!value) throw new CheckError('--rev needs a commit');
      opts.rev = value;
      opts.revGiven = true;
      i += 1;
    } else throw new CheckError(`unknown argument "${a}"; use [--rev <commit>] [--self]`);
  }
  return opts;
}

function warnUncommitted() {
  const dirty = git(['status', '--porcelain', '-z']).split('\0').filter(Boolean);
  if (dirty.length === 0) return;
  process.stderr.write(
    `upstream:check: warning: uncommitted changes are not checked (the guard compares commits):\n${dirty.map((d) => `  ${d}`).join('\n')}\n`,
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.revGiven) warnUncommitted();
  const violations = opts.self ? checkSelf(opts.rev) : checkClone(opts.rev);
  if (violations.length === 0) {
    process.stdout.write(`upstream:check OK (${opts.self ? 'self' : opts.rev})\n`);
    return 0;
  }
  for (const v of violations)
    process.stderr.write(
      `${v.path}: ${v.kind}${v.path.startsWith(UPSTREAM_DOCS_PREFIX) ? ` (${PROJECT_DOCS_HINT})` : ''}\n`,
    );
  process.stderr.write(`upstream:check found ${violations.length} violation(s)\n`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CheckError)) throw e;
  process.stderr.write(`upstream:check: ${e.message}\n`);
  process.exitCode = 1;
}
```
Lỗi không lường trước (git hỏng, không phải repo git) không bị bắt: Node in stack và thoát 1 (fail loud).

`package.json` — thêm vào `scripts`:
```json
    "upstream:check": "node tools/upstream/check.mjs",
```

- [ ] **Step 6: Ca fixture xanh, commit, rồi ca repo thật**

Ca repo thật đọc cây **đã commit** (`HEAD`, đúng như CI), nên chạy sau commit:
```bash
pnpm vitest run --project unit test/unit/upstream/self.spec.ts -t "on an upstream fixture"
pnpm exec prettier --write .upstream/zones.json tools/upstream/check.mjs test/support/upstream-fixture.ts test/unit/upstream package.json
pnpm lint && pnpm typecheck
git add .upstream/zones.json tools/upstream/check.mjs test/support/upstream-fixture.ts test/unit/upstream package.json
git commit -m "feat(upstream): zones.json and the zone guard (tree comparison with the recorded upstream commit, keyed package checks, --self)"
pnpm vitest run --project unit test/unit/upstream/self.spec.ts
node tools/upstream/check.mjs --self
```
Expected: hai ca fixture PASS trước commit; sau commit cả ba ca PASS và lệnh cuối in `upstream:check OK (self)`. Ca repo thật đỏ (file chưa phân vùng, hoặc file vùng dự án ngoài `projectSeed`) → sửa `.upstream/zones.json` cho đúng bảng 6.1 (không thêm vùng mới ngoài spec; file thật sự lạ thì hỏi), `git commit --amend --no-edit`, chạy lại.

---
### Task 7: `tools/upstream/init.mjs` (khởi tạo clone) + `tools/upstream/zones.mjs` + `docs/upstream/CODEOWNERS.template`; guard trên clone thật (UP-1…UP-5, Review Focus 1, 2, 5)

**Files:**
- Create: `tools/upstream/zones.mjs`, `tools/upstream/init.mjs`, `docs/upstream/CODEOWNERS.template`, `test/unit/upstream/check.spec.ts`, `test/unit/upstream/init.spec.ts`, `test/unit/upstream/codeowners-template.spec.ts`
- Modify: `package.json` (script `upstream:init`)

**Interfaces:**
- Consumes: `.upstream/zones.json`, `tools/upstream/check.mjs` (Task 6); helper `test/support/upstream-fixture.ts` (Task 6: `createUpstream`, `initProject`, `cloneAtTag`, `removeRepo`, `FIXTURE_APP_MODULES_AFTER_INIT`).
- Produces:
  - `tools/upstream/zones.mjs`: `class ZonesError`, `parseZones(text: string, source: string): { entries: { pattern: string; zone: string }[]; projectSeed: Set<string> }`, `zoneOf(zones, path): { zone: string; explicit: boolean }` (cùng luật với bản riêng trong `check.mjs`; `check.mjs` giữ bản của nó vì phải là một file chạy từ stdin). Dùng bởi `init.mjs`, `sync.mjs` (Task 8).
  - `node tools/upstream/init.mjs --team-core @org/team --team-app @org/team`: trên clone sạch đang ở tag `vX.Y.Z`: ghi `.upstream/version.json` `{ tag, commit }`; chép `src/plans.example.ts` → `src/app.plans.ts` (nếu có); chép mỗi `src/migrations/example/Migration<ts>_starter_*.ts` → `src/migrations/app/Migration<ts mới>_starter_*.ts` (tên lớp đổi theo, thứ tự giữ); `git rm` mọi path vùng template; xoá mọi dòng `// upstream:template` và đổi `./plans.example.js` → `./app.plans.js` trong `src/app.modules.ts`; ghi `.github/CODEOWNERS` từ template; thay `README.md`; `git add` các file này; in bước tiếp theo. Không commit. Lỗi → `upstream:init: <thông điệp>` exit 1.
  - Script `"upstream:init": "node tools/upstream/init.mjs"`.

- [ ] **Step 1: Test (fail)**

`test/unit/upstream/check.spec.ts` (guard trên clone thật; cần `init.mjs` của task này để dựng clone):
```ts
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUpstream,
  initProject,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

/** Mỗi ca dựng upstream + clone thật bằng git: rộng hơn nhiều so với thực tế. */
const GIT_CASE_TIMEOUT_MS = 60_000;

describe('upstream:check on a clone (spec SP7 §13.2, §13.3)', { timeout: GIT_CASE_TIMEOUT_MS }, () => {
  let up: Repo | undefined;
  let clone: Repo;
  beforeEach(() => {
    up = createUpstream();
    clone = initProject(up);
  });
  afterEach(() => {
    removeRepo(clone);
    removeRepo(up);
  });
  const check = () => clone.tool('check');

  it('a freshly initialized clone passes', () => {
    const r = check();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('upstream:check OK (HEAD)');
  });

  it('UP-1: a modified boilerplate file fails, naming the path', () => {
    clone.write('src/core/x.ts', 'export const x = 2;\n');
    clone.commitAll('fix: patch core locally');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/core/x.ts: modified in the boilerplate zone');
  });

  it('UP-2: a deleted boilerplate file fails', () => {
    clone.remove('src/core/x.ts');
    clone.commitAll('chore: drop core file');
    expect(check().stderr).toContain('src/core/x.ts: deleted from the boilerplate zone');
  });

  it('UP-3: the deleted template zone passes; a template file restored with changes or a new template file fails', () => {
    expect(clone.exists('src/features/example/example.ts')).toBe(false);
    clone.write('src/features/example/example.ts', 'export const example = 2;\n');
    clone.write('src/features/example/new.ts', 'export const n = 1;\n');
    clone.commitAll('feat: edit the sample');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/features/example/example.ts: modified in the template zone (delete it instead)');
    expect(r.stderr).toContain('src/features/example/new.ts: added in the template zone');
  });

  it('UP-4: package.json keeps upstream dependency specs and scripts; project scripts need the app: prefix', () => {
    const pkg = JSON.parse(clone.read('package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
      version: string;
    };
    pkg.dependencies.zod = '4.7.0';
    pkg.dependencies.dayjs = '1.11.13';
    pkg.scripts.seed = 'node seed.mjs';
    pkg.scripts['app:seed'] = 'node seed.mjs';
    pkg.version = '3.2.1';
    clone.write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    clone.commitAll('chore: deps');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('package.json: dependencies.zod must stay 4.6.5 (upstream), found 4.7.0');
    expect(r.stderr).toContain('package.json: scripts.seed: project scripts must start with "app:"');
    expect(r.stderr).not.toContain('dayjs');
    expect(r.stderr).not.toContain('app:seed');
    expect(r.stderr).not.toContain('version');
  });

  it('pnpm-workspace.yaml: an upstream line changed fails, a project addition passes', () => {
    clone.write('pnpm-workspace.yaml', 'minimumReleaseAge: 0\nallowBuilds:\n  esbuild: true\n  sharp: true\n');
    clone.commitAll('chore: workspace');
    const r = check();
    expect(r.stderr).toContain('pnpm-workspace.yaml: upstream line "minimumReleaseAge: 1440" is missing or changed');
    expect(r.stderr).not.toContain('sharp');
  });

  it('UP-5a: loosening zones.json at HEAD does not help (zones are read from the upstream commit)', () => {
    const zones = JSON.parse(clone.read('.upstream/zones.json')) as { boilerplate: string[]; project: string[] };
    zones.boilerplate = zones.boilerplate.filter((p) => p !== 'src/core/');
    zones.project.push('src/core/');
    clone.write('.upstream/zones.json', `${JSON.stringify(zones, null, 2)}\n`);
    clone.write('src/core/x.ts', 'export const x = 2;\n');
    clone.commitAll('chore: loosen zones');
    const r = check();
    expect(r.stderr).toContain('.upstream/zones.json: modified in the boilerplate zone');
    expect(r.stderr).toContain('src/core/x.ts: modified in the boilerplate zone');
  });

  it('UP-5b: a check.mjs edited at HEAD to always pass still fails, because CI runs the upstream copy', () => {
    clone.write('tools/upstream/check.mjs', 'process.exit(0);\n');
    clone.write('src/core/x.ts', 'export const x = 2;\n');
    clone.commitAll('chore: silence the guard');
    const commit = (JSON.parse(clone.read('.upstream/version.json')) as { commit: string }).commit;
    // Đúng lệnh của `.github/workflows/upstream-guard.yml` (bước "clone").
    const script = clone.git('show', `${commit}:tools/upstream/check.mjs`);
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: clone.dir,
      input: script,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tools/upstream/check.mjs: modified in the boilerplate zone');
    expect(r.stderr).toContain('src/core/x.ts: modified in the boilerplate zone');
  });

  it('Review Focus 1: reports a modified path with spaces and non-ASCII characters exactly, with the docs/app hint', () => {
    clone.write('docs/superpowers/ghi chú.md', 'project notes\n');
    clone.commitAll('docs: notes');
    expect(check().stderr).toContain(
      'docs/superpowers/ghi chú.md: modified in the boilerplate zone (project documents belong in docs/app/; docs/superpowers/ is upstream history)',
    );
  });

  it.each([
    ['invalid JSON', '{ "tag": "v0.1.0", ', '.upstream/version.json: invalid JSON'],
    ['a short commit', '{ "tag": "v0.1.0", "commit": "abc1234" }\n', 'must be a full 40-character lowercase commit SHA'],
    ['no tag', `{ "commit": "${'a'.repeat(40)}" }\n`, '"tag" must look like vX.Y.Z'],
  ])('Review Focus 2: a malformed version.json (%s) fails with one clear line and no stack trace', (_name, content, message) => {
    clone.write('.upstream/version.json', content);
    clone.commitAll('chore: hand-edit version');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('Review Focus 2: a missing version.json points at init / --self', () => {
    clone.remove('.upstream/version.json');
    clone.commitAll('chore: drop version');
    expect(check().stderr).toContain('.upstream/version.json is missing at HEAD');
  });

  it('Review Focus 5: warns that uncommitted changes are not checked', () => {
    clone.write('src/core/x.ts', 'export const x = 3;\n');
    const r = check();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('upstream:check: warning: uncommitted changes are not checked');
    expect(r.stderr).toContain('src/core/x.ts');
  });

  it('--rev checks another commit than HEAD', () => {
    const good = clone.git('rev-parse', 'HEAD');
    clone.write('src/core/x.ts', 'export const x = 2;\n');
    clone.commitAll('fix: patch core');
    expect(clone.tool('check', ['--rev', good]).status).toBe(0);
    expect(clone.tool('check').status).toBe(1);
  });
});
```

`test/unit/upstream/init.spec.ts`:
```ts
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_APP_MODULES_AFTER_INIT,
  cloneAtTag,
  createUpstream,
  initProject,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

const GIT_CASE_TIMEOUT_MS = 60_000;
const STARTER = /^(Migration\d{14})_starter_plans\.ts$/;

describe('upstream:init (spec SP7 §6.3.4, S7-D36)', { timeout: GIT_CASE_TIMEOUT_MS }, () => {
  let up: Repo;
  let clone: Repo | undefined;
  beforeEach(() => {
    up = createUpstream();
  });
  afterEach(() => {
    removeRepo(clone);
    clone = undefined;
    removeRepo(up);
  });

  it('records the upstream version, copies the seeds, deletes the template zone and rewrites the project seed files', () => {
    clone = initProject(up);
    expect(JSON.parse(clone.read('.upstream/version.json'))).toEqual({
      tag: 'v0.1.0',
      commit: up.git('rev-parse', 'v0.1.0^{commit}'),
    });
    expect(clone.read('src/app.plans.ts')).toBe(up.read('src/plans.example.ts'));
    const starters = readdirSync(join(clone.dir, 'src/migrations/app'));
    expect(starters).toHaveLength(1);
    const [file] = starters;
    const m = STARTER.exec(file ?? '');
    expect(m, file).not.toBeNull();
    expect(m?.[1] && m[1] > 'Migration20260101000000').toBe(true);
    const body = clone.read(`src/migrations/app/${file ?? ''}`);
    expect(body).toContain(`class ${basename(file ?? '', '.ts')} `);
    expect(body).not.toContain('Migration20260101000000');
    for (const p of [
      'src/plans.example.ts',
      'src/features/example/example.ts',
      'src/migrations/example/Migration20260101000000_starter_plans.ts',
    ])
      expect(clone.exists(p), p).toBe(false);
    expect(clone.read('src/app.modules.ts')).toBe(FIXTURE_APP_MODULES_AFTER_INIT);
    const owners = clone.read('.github/CODEOWNERS');
    expect(owners).toContain('* @acme/app');
    expect(owners).toContain('/src/core/ @acme/platform');
    expect(owners).toContain('/src/features/ @acme/app');
    expect(owners).not.toContain('@TEAM_');
    expect(clone.read('README.md')).toMatch(
      new RegExp(`^# ${basename(clone.dir)}\\n\\nDự án clone từ NestJS SaaS Boilerplate v0\\.1\\.0\\.`),
    );
    expect(clone.tool('check').status).toBe(0);
  });

  it('refuses a clone that is already initialized', () => {
    clone = initProject(up);
    const r = clone.tool('init', ['--team-core', '@acme/platform', '--team-app', '@acme/app']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('upstream:init: .upstream/version.json already exists: this clone is already initialized');
  });

  it('refuses a HEAD that is not a release tag, a dirty tree and malformed teams', () => {
    clone = cloneAtTag(up, 'v0.1.0');
    const run = (args: string[]) => clone?.tool('init', args);
    expect(run(['--team-core', 'platform', '--team-app', '@acme/app'])?.stderr).toContain(
      '--team-core needs a GitHub team or user like @org/team',
    );
    expect(run(['--team-core', '@acme/platform'])?.stderr).toContain(
      'both --team-core and --team-app are required',
    );
    clone.write('scratch.txt', 'x\n');
    expect(run(['--team-core', '@acme/platform', '--team-app', '@acme/app'])?.stderr).toContain(
      'the working tree is not clean',
    );
    clone.commitAll('chore: work after the tag');
    expect(run(['--team-core', '@acme/platform', '--team-app', '@acme/app'])?.stderr).toContain(
      'HEAD is not a release tag',
    );
    expect(clone.exists('.upstream/version.json')).toBe(false);
  });
});
```
`test/unit/upstream/codeowners-template.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const Zones = z.object({
  boilerplate: z.array(z.string()),
  template: z.array(z.string()),
  project: z.array(z.string()),
});
const weight = (p: string) => (p.endsWith('*') ? p.length - 1 : p.length);
const row = (pattern: string, team: string): [string, string] => [pattern, team];

describe('docs/upstream/CODEOWNERS.template follows .upstream/zones.json', () => {
  it('core team owns boilerplate and template paths, app team owns project paths, most specific pattern last', () => {
    const zones = Zones.parse(JSON.parse(readFileSync('.upstream/zones.json', 'utf8')));
    const rows = [
      ...zones.boilerplate.map((p) => row(p, '@TEAM_CORE')),
      ...zones.template.map((p) => row(p, '@TEAM_CORE')),
      ...zones.project.map((p) => row(p, '@TEAM_APP')),
    ].sort(([a], [b]) => weight(a) - weight(b) || (a < b ? -1 : a > b ? 1 : 0));
    const lines = readFileSync('docs/upstream/CODEOWNERS.template', 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines).toEqual(['* @TEAM_APP', ...rows.map(([p, t]) => `/${p} ${t}`)]);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/upstream/check.spec.ts test/unit/upstream/init.spec.ts test/unit/upstream/codeowners-template.spec.ts`
Expected: FAIL — `init failed` / `ENOENT … tools/upstream/init.mjs` (fixture không có `init.mjs`), `ENOENT docs/upstream/CODEOWNERS.template`.

- [ ] **Step 3: `tools/upstream/zones.mjs`**

```js
// Vùng sở hữu (spec SP7 §6.1) cho init.mjs và sync.mjs. check.mjs giữ bản riêng cùng luật vì phải là MỘT file chạy
// được từ stdin; test của cả ba công cụ chạy trên cùng .upstream/zones.json.
export const ZONE_NAMES = ['boilerplate', 'project', 'template', 'generated', 'shared'];

export class ZonesError extends Error {}

function matches(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}
const weight = (pattern) => (pattern.endsWith('*') ? pattern.length - 1 : pattern.length);

/** Tiền tố dài nhất thắng; không khớp mục nào → vùng dự án (không tường minh). */
export function zoneOf(zones, path) {
  let best;
  for (const e of zones.entries)
    if (matches(e.pattern, path) && (!best || weight(e.pattern) > weight(best.pattern))) best = e;
  return best ? { zone: best.zone, explicit: true } : { zone: 'project', explicit: false };
}

export function parseZones(text, source) {
  let z;
  try {
    z = JSON.parse(text);
  } catch (e) {
    throw new ZonesError(`${source}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (z?.version !== 1) throw new ZonesError(`${source}: "version" must be 1`);
  const entries = [];
  const owner = new Map();
  for (const zone of ZONE_NAMES) {
    const list = z[zone];
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || p === ''))
      throw new ZonesError(`${source}: "${zone}" must be an array of non-empty strings`);
    for (const pattern of list) {
      if (owner.has(pattern))
        throw new ZonesError(`${source}: "${pattern}" is listed in both ${owner.get(pattern)} and ${zone}`);
      owner.set(pattern, zone);
      entries.push({ pattern, zone });
    }
  }
  const zones = { entries, projectSeed: new Set() };
  if (!Array.isArray(z.projectSeed)) throw new ZonesError(`${source}: "projectSeed" must be an array`);
  for (const seed of z.projectSeed) {
    const at = zoneOf(zones, seed);
    if (!at.explicit || at.zone !== 'project')
      throw new ZonesError(`${source}: projectSeed "${seed}" is not an explicit project-zone path`);
    zones.projectSeed.add(seed);
  }
  return zones;
}
```

- [ ] **Step 4: `tools/upstream/init.mjs`, `docs/upstream/CODEOWNERS.template`, script**

`tools/upstream/init.mjs`:
```js
// Khởi tạo dự án từ một clone của boilerplate (spec SP7 §6.3.4, S7-D36). Node ESM thuần, chỉ node:*.
//   node tools/upstream/init.mjs --team-core @org/platform --team-app @org/app
// Chạy MỘT lần trên clone sạch đang ở đúng một tag vX.Y.Z, trước lần deploy production đầu tiên. Không commit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ZonesError, parseZones, zoneOf } from './zones.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const TEAM = /^@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?$/;
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const PLANS_TEMPLATE = 'src/plans.example.ts';
const PLANS_PROJECT = 'src/app.plans.ts';
const TEMPLATE_MIGRATIONS_DIR = 'src/migrations/example';
const PROJECT_MIGRATIONS_DIR = 'src/migrations/app';
const STARTER_MIGRATION = /^(Migration\d{14})_(starter_[a-z0-9_]+)\.ts$/;
const APP_MODULES = 'src/app.modules.ts';
const TEMPLATE_LINE_MARKER = '// upstream:template';
const PLANS_IMPORT_TEMPLATE = './plans.example.js';
const PLANS_IMPORT_PROJECT = './app.plans.js';
const CODEOWNERS_TEMPLATE = 'docs/upstream/CODEOWNERS.template';
const CODEOWNERS = '.github/CODEOWNERS';
const README = 'README.md';
const TEAM_CORE_TOKEN = '@TEAM_CORE';
const TEAM_APP_TOKEN = '@TEAM_APP';
const MS_PER_SECOND = 1000;
const GIT_RM_BATCH = 100;

class InitError extends Error {}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Đúng công thức tên của `mikro-orm migration:create` (@mikro-orm/migrations 7.2.1, MigrationGenerator.js:20). */
const migrationStamp = (d) => d.toISOString().replace(/[-T:]|\.\d{3}z$/gi, '');
const semver = (tag) => TAG.exec(tag).slice(1, 4).map(Number);
function newer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--team-core' && flag !== '--team-app')
      throw new InitError(`unknown argument "${flag}"; use --team-core @org/team --team-app @org/team`);
    if (!value || !TEAM.test(value))
      throw new InitError(`${flag} needs a GitHub team or user like @org/team`);
    opts[flag === '--team-core' ? 'teamCore' : 'teamApp'] = value;
  }
  if (!opts.teamCore || !opts.teamApp)
    throw new InitError('both --team-core and --team-app are required');
  return opts;
}

function releaseTagAtHead() {
  const tags = git('tag', '--points-at', 'HEAD')
    .split('\n')
    .filter((t) => TAG.test(t));
  if (tags.length === 0)
    throw new InitError(
      'HEAD is not a release tag; clone the boilerplate at a tag (git clone --branch vX.Y.Z <url>) and run init before any other commit',
    );
  return tags.reduce((best, t) => (newer(semver(t), semver(best)) ? t : best));
}

function copyStarterMigrations() {
  if (!existsSync(TEMPLATE_MIGRATIONS_DIR)) return [];
  const starters = readdirSync(TEMPLATE_MIGRATIONS_DIR)
    .filter((f) => STARTER_MIGRATION.test(f))
    .sort();
  const base = Date.now();
  return starters.map((file, i) => {
    const [, oldClass, suffix] = STARTER_MIGRATION.exec(file);
    const oldName = `${oldClass}_${suffix}`;
    const newName = `Migration${migrationStamp(new Date(base + i * MS_PER_SECOND))}_${suffix}`;
    mkdirSync(PROJECT_MIGRATIONS_DIR, { recursive: true });
    const target = `${PROJECT_MIGRATIONS_DIR}/${newName}.ts`;
    writeFileSync(target, readFileSync(join(TEMPLATE_MIGRATIONS_DIR, file), 'utf8').replaceAll(oldName, newName));
    return target;
  });
}

function removeTemplateZone(zones) {
  const paths = git('ls-files', '-z')
    .split('\0')
    .filter((p) => p && zoneOf(zones, p).zone === 'template');
  for (let i = 0; i < paths.length; i += GIT_RM_BATCH)
    git('rm', '-q', '--', ...paths.slice(i, i + GIT_RM_BATCH));
  return paths;
}

function rewriteAppModules() {
  const lines = readFileSync(APP_MODULES, 'utf8')
    .split('\n')
    .filter((l) => !l.trimEnd().endsWith(TEMPLATE_LINE_MARKER));
  writeFileSync(APP_MODULES, lines.join('\n').replaceAll(PLANS_IMPORT_TEMPLATE, PLANS_IMPORT_PROJECT));
}

const readmeFor = (name, tag) =>
  `# ${name}\n\nDự án clone từ NestJS SaaS Boilerplate ${tag}. Tài liệu của boilerplate: [docs/boilerplate/README.md](docs/boilerplate/README.md). Tài liệu của dự án đặt ở \`docs/app/\`.\n`;

function main(argv) {
  const opts = parseArgs(argv);
  if (git('status', '--porcelain') !== '')
    throw new InitError('the working tree is not clean; run init on a fresh clone');
  if (existsSync(VERSION_FILE))
    throw new InitError(`${VERSION_FILE} already exists: this clone is already initialized`);
  const tag = releaseTagAtHead();
  const commit = git('rev-parse', 'HEAD');
  const zones = parseZones(readFileSync(ZONES_FILE, 'utf8'), ZONES_FILE);

  mkdirSync('.upstream', { recursive: true });
  writeFileSync(VERSION_FILE, `${JSON.stringify({ tag, commit }, null, 2)}\n`);
  const written = [VERSION_FILE, APP_MODULES, CODEOWNERS, README];
  if (existsSync(PLANS_TEMPLATE)) {
    writeFileSync(PLANS_PROJECT, readFileSync(PLANS_TEMPLATE, 'utf8'));
    written.push(PLANS_PROJECT);
  }
  written.push(...copyStarterMigrations());
  const removed = removeTemplateZone(zones);
  rewriteAppModules();
  mkdirSync('.github', { recursive: true });
  writeFileSync(
    CODEOWNERS,
    readFileSync(CODEOWNERS_TEMPLATE, 'utf8')
      .replaceAll(TEAM_CORE_TOKEN, opts.teamCore)
      .replaceAll(TEAM_APP_TOKEN, opts.teamApp),
  );
  writeFileSync(README, readmeFor(basename(process.cwd()), tag));
  git('add', '--', ...written);

  process.stdout.write(
    [
      `upstream:init done for ${tag} (${removed.length} template file(s) removed). Nothing is committed. Next:`,
      '  1. Review src/app.plans.ts and src/migrations/app/*_starter_* against your real plans (docs/boilerplate/README.md "Khởi tạo dự án").',
      '  2. Billing enabled? Write your price seed migration (docs/boilerplate/README.md "Seed giá cho billing").',
      '  3. git remote rename origin upstream && git remote add origin <your repository URL>',
      `  4. git commit -m "chore: initialize project from boilerplate ${tag}"`,
      '  5. Protect main so upstream sync PRs are merged with a merge commit (docs/upstream/merge.md).',
      '',
    ].join('\n'),
  );
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof InitError) && !(e instanceof ZonesError)) throw e;
  process.stderr.write(`upstream:init: ${e.message}\n`);
  process.exitCode = 1;
}
```
`docs/upstream/CODEOWNERS.template` (sinh theo đúng thuật toán của `codeowners-template.spec.ts`; dòng sau cùng thắng trong CODEOWNERS, nên mẫu cụ thể hơn đứng sau):
```
# CODEOWNERS của dự án, sinh bởi `pnpm upstream:init` từ docs/upstream/CODEOWNERS.template (spec SP7 §6.1).
# @TEAM_CORE: team nền, review mọi thay đổi vùng boilerplate/template (chỉ tới qua đồng bộ upstream).
# @TEAM_APP: team dự án. Branch protection bật "Require review from Code Owners" (docs/upstream/merge.md).
# Sinh lại khi .upstream/zones.json đổi (test/unit/upstream/codeowners-template.spec.ts giữ hai file khớp nhau).
```
nối tiếp đúng 78 dòng in bởi lệnh dưới (chạy từ gốc repo sau Step 1 của Task 6):
```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const z = JSON.parse(readFileSync('.upstream/zones.json', 'utf8'));
const w = (p) => (p.endsWith('*') ? p.length - 1 : p.length);
const rows = [...z.boilerplate.map((p) => [p, '@TEAM_CORE']), ...z.template.map((p) => [p, '@TEAM_CORE']), ...z.project.map((p) => [p, '@TEAM_APP'])]
  .sort((a, b) => w(a[0]) - w(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
console.log(['* @TEAM_APP', ...rows.map(([p, t]) => '/' + p + ' ' + t)].join('\n'));
" >> docs/upstream/CODEOWNERS.template
```
Dòng đầu phải là `* @TEAM_APP`, tiếp theo `/test/ @TEAM_CORE`, …, dòng cuối `/.github/workflows/upstream-guard.yml @TEAM_CORE` (danh sách đầy đủ đã sinh lúc viết plan, 78 dòng, khớp `zones.json` của Task 6).

`package.json` — thêm vào `scripts`:
```json
    "upstream:init": "node tools/upstream/init.mjs",
```

- [ ] **Step 5: Chạy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/upstream
```
Expected: PASS — `check.spec.ts` (clone sạch xanh; UP-1, UP-2, UP-3, UP-4, `pnpm-workspace.yaml`, UP-5a, UP-5b, Review Focus 1, 2 ×4, 5, `--rev`), `init.spec.ts` 3/3, `codeowners-template.spec.ts` 1/1, `self.spec.ts` 3/3.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write tools/upstream test/unit/upstream package.json
pnpm lint && pnpm typecheck
git add tools/upstream docs/upstream/CODEOWNERS.template test/unit/upstream package.json
git commit -m "feat(upstream): upstream:init (seed copies, template zone removal, CODEOWNERS) and guard tests on real clones (UP-1…UP-5)"
```

---
### Task 8: `tools/upstream/sync.mjs` — merge một tag upstream, state machine suy ra từ git (UP-6, UP-6b, UP-7, UP-8, UP-11, R7-16, Review Focus 3)

**Files:**
- Create: `tools/upstream/sync.mjs`, `test/unit/upstream/sync.spec.ts`
- Modify: `package.json` (scripts `upstream:sync`, `upstream:regenerate`, `upstream:verify`)

**Interfaces:**
- Consumes: `parseZones`, `zoneOf`, `ZonesError` (`tools/upstream/zones.mjs`, Task 7); `tools/upstream/check.mjs --rev` (Task 6); helper `createUpstream`, `releaseUpstream`, `initProject`, `removeRepo` (Task 6).
- Produces:
  - `node tools/upstream/sync.mjs vX.Y.Z | --continue`. Trạng thái (spec 8.2): `CLEAN` → kiểm tag, in Upgrade notes, xác nhận (gõ lại tag trên stdin), `git merge --no-ff --no-commit <tag>`; `MERGING_AUTO` → tự giải (boilerplate/generated: bản upstream, hoặc `git rm` nếu upstream xoá; template: `git rm` nếu phía dự án đã xoá, không thì bản upstream); `MERGING_MANUAL` → in path + vùng, exit 3; `REGENERATE` → giữ vùng template đã xoá, `node --run upstream:regenerate`, ghi `.upstream/version.json` `{ tag, commit }`, `git add` nó và file sinh ra; `VERIFY` → `git commit-tree` tạm rồi `check.mjs --rev <tạm>`, `node --run upstream:verify`; `DONE` → in lệnh commit/PR, exit 0. Trạng thái git lạ (rebase, cherry-pick…) hoặc lỗi → `upstream:sync: <thông điệp>` exit 1.
  - Scripts: `"upstream:sync": "node tools/upstream/sync.mjs"`, `"upstream:regenerate": "pnpm install && pnpm env:example && pnpm build && pnpm openapi:export"`, `"upstream:verify": "pnpm install --frozen-lockfile && pnpm lint && pnpm test"` (spec 13.4 bước 6–7; `upstream:check` chạy riêng trên kết quả merge).

- [ ] **Step 1: Test (fail)**

`test/unit/upstream/sync.spec.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUpstream,
  initProject,
  releaseUpstream,
  removeRepo,
  type Repo,
} from '../../support/upstream-fixture.js';

/** Upstream + clone + một hoặc hai lượt sync thật bằng git và node: rộng hơn nhiều so với thực tế. */
const GIT_CASE_TIMEOUT_MS = 120_000;
const STARTER = 'src/migrations/example/Migration20260101000000_starter_plans.ts';
const V2 = {
  write: {
    'src/core/x.ts': 'export const x = 2;\n',
    'src/features/example/new.ts': 'export const n = 1;\n',
    [STARTER]:
      'export class Migration20260101000000_starter_plans {\n  override name = "Migration20260101000000_starter_plans";\n  readonly v = 2;\n}\n',
    '.env.example': 'A=2\n',
  },
  notes: 'core x is now 2',
};

describe('upstream:sync (spec SP7 §13.4, §8.2)', { timeout: GIT_CASE_TIMEOUT_MS }, () => {
  let up: Repo;
  let clone: Repo;
  beforeEach(() => {
    up = createUpstream();
    clone = initProject(up);
    releaseUpstream(up, 'v0.2.0', V2);
  });
  afterEach(() => {
    removeRepo(clone);
    removeRepo(up);
  });
  const sync = (args: string[], input = '') => clone.tool('sync', args, input);
  const branchFor = (tag: string, from = 'main') =>
    clone.git('switch', '-q', '-c', `chore/upstream-${tag}`, from);
  const recorded = () =>
    JSON.parse(clone.read('.upstream/version.json')) as { tag: string; commit: string };

  it('UP-7: resolves known conflicts itself, keeps the template deleted, regenerates, records the version and leaves the project version alone', () => {
    const pkg = JSON.parse(clone.read('package.json')) as { version: string };
    pkg.version = '7.0.0';
    clone.write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    clone.commitAll('chore: project version');
    branchFor('v0.2.0');
    const r = sync(['v0.2.0'], 'v0.2.0\n');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('core x is now 2');
    expect(clone.read('src/core/x.ts')).toBe('export const x = 2;\n');
    expect(clone.exists('src/features/example/new.ts')).toBe(false);
    expect(clone.exists(STARTER)).toBe(false);
    expect(clone.read('.env.example')).toBe('REGENERATED=1\n');
    expect(recorded()).toEqual({ tag: 'v0.2.0', commit: up.git('rev-parse', 'v0.2.0^{commit}') });
    expect((JSON.parse(clone.read('package.json')) as { version: string }).version).toBe('7.0.0');
    clone.git('commit', '-q', '--no-edit');
    expect(clone.tool('check').status).toBe(0);
  });

  it('UP-7: a boilerplate file the project changed by mistake is reset to the upstream version', () => {
    clone.write('src/core/x.ts', 'export const x = 9;\n');
    clone.commitAll('fix: local core patch');
    branchFor('v0.2.0');
    const r = sync(['v0.2.0'], 'v0.2.0\n');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('auto-resolved src/core/x.ts (boilerplate)');
    expect(clone.read('src/core/x.ts')).toBe('export const x = 2;\n');
  });

  it('UP-8: stops at MERGING_MANUAL on a project-zone conflict, then --continue completes; notes of every release in between are shown', () => {
    releaseUpstream(up, 'v0.3.0', { write: { 'README.md': '# Boilerplate v3\n' }, notes: 'readme moved' });
    branchFor('v0.3.0');
    const first = sync(['v0.3.0'], 'v0.3.0\n');
    expect(first.status).toBe(3);
    expect(first.stdout).toContain('core x is now 2');
    expect(first.stdout).toContain('readme moved');
    expect(first.stderr).toContain('  README.md (project)');
    clone.git('checkout', '--ours', '--', 'README.md');
    clone.git('add', '--', 'README.md');
    const done = sync(['--continue']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(recorded().tag).toBe('v0.3.0');
    clone.git('commit', '-q', '--no-edit');
    expect(clone.tool('check').status).toBe(0);
  });

  it('Review Focus 3: refuses a non-newer tag, a tag off upstream/main, the wrong branch and a wrong confirmation, leaving the tree untouched', () => {
    expect(sync(['v0.2.0'], 'v0.2.0\n').stderr).toContain(
      'upstream:sync: run sync on a new branch named chore/upstream-v0.2.0 created from main (current: main)',
    );
    branchFor('v0.2.0');
    expect(sync(['v0.1.0'], 'v0.1.0\n').stderr).toContain('v0.1.0 is not newer than the current v0.1.0');
    up.git('switch', '-q', '-c', 'side', 'v0.1.0');
    up.write('src/core/x.ts', 'export const x = 42;\n');
    up.commitAll('feat: side line');
    up.git('tag', 'v0.9.0');
    up.git('switch', '-q', 'main');
    expect(sync(['v0.9.0'], 'v0.9.0\n').stderr).toContain('v0.9.0 is not on upstream/main');
    expect(sync(['v0.2.0'], 'v0.2.1\n').stderr).toContain('upgrade notes not confirmed; nothing changed');
    expect(sync(['v0.2.0'], '').stderr).toContain('stdin closed before the confirmation was typed');
    expect(sync(['nope']).stderr).toContain('"nope" is not a release tag like vX.Y.Z');
    expect(clone.gitRaw('rev-parse', '-q', '--verify', 'MERGE_HEAD').status).not.toBe(0);
    expect(clone.git('status', '--porcelain')).toBe('');
  });

  it('UP-6: a squash-merged sync PR breaks the ancestry and the guard says so; UP-6b: merge -s ours restores it without changing the tree', () => {
    branchFor('v0.2.0');
    expect(sync(['v0.2.0'], 'v0.2.0\n').status).toBe(0);
    clone.git('commit', '-q', '--no-edit');
    clone.git('switch', '-q', 'main');
    clone.git('merge', '-q', '--squash', 'chore/upstream-v0.2.0');
    clone.git('commit', '-q', '-m', 'chore: sync upstream v0.2.0 (squashed)');
    const squashed = clone.tool('check');
    expect(squashed.status).toBe(1);
    expect(squashed.stderr).toContain('is not in history (squash-merged sync PR?)');
    clone.git('switch', '-q', '-c', 'fix/upstream-ancestry');
    clone.git('merge', '-q', '-s', 'ours', '--no-ff', 'v0.2.0', '-m', 'chore: restore the upstream ancestry of v0.2.0');
    expect(clone.git('diff', 'HEAD~1', 'HEAD')).toBe('');
    expect(clone.tool('check').status).toBe(0);
  });

  it('UP-11 (R7-16): two syncs on two branches — the later PR conflicts on version.json and must sync again', () => {
    releaseUpstream(up, 'v0.3.0', { write: { 'src/core/x.ts': 'export const x = 3;\n' } });
    branchFor('v0.2.0');
    expect(sync(['v0.2.0'], 'v0.2.0\n').status).toBe(0);
    clone.git('commit', '-q', '--no-edit');
    branchFor('v0.3.0');
    expect(sync(['v0.3.0'], 'v0.3.0\n').status).toBe(0);
    clone.git('commit', '-q', '--no-edit');
    clone.git('switch', '-q', 'main');
    clone.git('merge', '-q', '--no-ff', 'chore/upstream-v0.2.0', '-m', 'Merge sync v0.2.0');
    const late = clone.gitRaw('merge', '--no-ff', 'chore/upstream-v0.3.0', '-m', 'Merge sync v0.3.0');
    expect(late.status).not.toBe(0);
    expect(clone.git('diff', '--name-only', '--diff-filter=U')).toContain('.upstream/version.json');
    clone.git('merge', '--abort');
    clone.git('switch', '-q', '-C', 'chore/upstream-v0.3.0', 'main');
    const again = sync(['v0.3.0'], 'v0.3.0\n');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    clone.git('commit', '-q', '--no-edit');
    clone.git('switch', '-q', 'main');
    clone.git('merge', '-q', '--no-ff', 'chore/upstream-v0.3.0', '-m', 'Merge sync v0.3.0');
    expect(clone.tool('check').status).toBe(0);
    expect(recorded().tag).toBe('v0.3.0');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/upstream/sync.spec.ts`
Expected: FAIL 6/6 — fixture không có `tools/upstream/sync.mjs` (`Cannot find module`).

- [ ] **Step 3: `tools/upstream/sync.mjs` và scripts**

```js
// Merge một tag upstream vào clone (spec SP7 §13.4; state machine §8.2). Node ESM thuần, chỉ node:*.
//   node tools/upstream/sync.mjs vX.Y.Z      bắt đầu: cây sạch, trên nhánh chore/upstream-vX.Y.Z tạo từ main
//   node tools/upstream/sync.mjs --continue  sau khi đã giải xung đột tay và git add
// Trạng thái suy ra từ git (MERGE_HEAD, path chưa merge), không có file trạng thái. Không commit, không push.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ZonesError, parseZones, zoneOf } from './zones.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const BRANCH_PREFIX = 'chore/upstream-';
const REMOTE = 'upstream';
const UPSTREAM_MAIN = 'upstream/main';
const VERSION_FILE = '.upstream/version.json';
const ZONES_FILE = '.upstream/zones.json';
const CHANGELOG = 'CHANGELOG.md';
const CHECK_SCRIPT = 'tools/upstream/check.mjs';
const REGENERATE_SCRIPT = 'upstream:regenerate';
const VERIFY_SCRIPT = 'upstream:verify';
const EXIT_MANUAL = 3;
const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
const AUTO_ZONES = new Set(['boilerplate', 'template', 'generated']);
const GIT_RM_BATCH = 100;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

class SyncError extends Error {}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function gitExit(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (r.error) throw r.error;
  return r;
}
const zList = (out) => out.split('\0').filter(Boolean);
const exists = (rev, path) => gitExit('cat-file', '-e', `${rev}:${path}`).status === 0;
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new SyncError(`${[cmd, ...args].join(' ')} failed with exit ${r.status}`);
}

const semver = (tag) => TAG.exec(tag).slice(1, 4).map(Number);
function newer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function readRecorded() {
  if (!existsSync(VERSION_FILE))
    throw new SyncError(`${VERSION_FILE} is missing; run pnpm upstream:init first`);
  const v = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
  if (typeof v?.tag !== 'string' || !TAG.test(v.tag)) throw new SyncError(`${VERSION_FILE}: "tag" must look like vX.Y.Z`);
  return v;
}
function tagOf(commit) {
  const tags = git('tag', '--points-at', commit).split('\n').filter((t) => TAG.test(t));
  if (tags.length === 0) throw new SyncError(`no release tag points at ${commit}`);
  return tags.reduce((best, t) => (newer(semver(t), semver(best)) ? t : best));
}

/** Mục "### Upgrade notes" của mọi bản trong (from, to] (spec 13.4 bước 2). */
function upgradeNotes(changelog, fromTag, toTag) {
  const from = semver(fromTag);
  const to = semver(toTag);
  const out = [];
  for (const section of changelog.split(/^## /m).slice(1)) {
    const m = /^\[?(\d+)\.(\d+)\.(\d+)\]?/.exec(section);
    if (!m) continue;
    const v = m.slice(1, 4).map(Number);
    if (!newer(v, from) || newer(v, to)) continue;
    const notes = /^### Upgrade notes[ \t]*\r?\n([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(section);
    out.push(`## ${v.join('.')}\n${notes ? notes[1].trim() : '(no upgrade notes)'}`);
  }
  return out.length ? out.join('\n\n') : '(no CHANGELOG entry between the two tags)';
}

/** Hỏi một dòng; stdin đóng trước khi trả lời là lỗi (không bao giờ coi như đã xác nhận). */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.once('close', () => {
      if (!answered) reject(new SyncError('stdin closed before the confirmation was typed; nothing changed'));
    });
    rl.question(question).then(
      (a) => {
        answered = true;
        rl.close();
        resolve(a);
      },
      (e) => {
        answered = true;
        rl.close();
        reject(e);
      },
    );
  });
}

function detectState() {
  const gitDir = git('rev-parse', '--git-dir');
  for (const marker of IN_PROGRESS)
    if (existsSync(join(gitDir, marker)))
      throw new SyncError(`a git operation (${marker}) is in progress; finish or abort it first`);
  if (gitExit('rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0) return { kind: 'CLEAN' };
  const mergeHead = git('rev-parse', 'MERGE_HEAD^{commit}');
  const zones = parseZones(git('show', `${mergeHead}:${ZONES_FILE}`), `${ZONES_FILE}@MERGE_HEAD`);
  const unmerged = zList(git('diff', '--name-only', '-z', '--diff-filter=U'));
  const auto = unmerged.filter((p) => AUTO_ZONES.has(zoneOf(zones, p).zone));
  if (auto.length) return { kind: 'MERGING_AUTO', mergeHead, zones, paths: auto };
  if (unmerged.length) return { kind: 'MERGING_MANUAL', mergeHead, zones, paths: unmerged };
  return readRecorded().commit === mergeHead
    ? { kind: 'VERIFY', mergeHead, zones }
    : { kind: 'REGENERATE', mergeHead, zones };
}

async function start(tag) {
  if (!TAG.test(tag)) throw new SyncError(`"${tag}" is not a release tag like vX.Y.Z`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.startsWith(BRANCH_PREFIX))
    throw new SyncError(`run sync on a new branch named ${BRANCH_PREFIX}${tag} created from main (current: ${branch})`);
  if (git('status', '--porcelain') !== '') throw new SyncError('the working tree is not clean');
  if (gitExit('remote', 'get-url', REMOTE).status !== 0)
    throw new SyncError(`remote "${REMOTE}" is missing: git remote add ${REMOTE} <boilerplate URL>`);
  run('git', ['fetch', '--quiet', '--tags', REMOTE]);
  if (gitExit('rev-parse', '-q', '--verify', `refs/tags/${tag}`).status !== 0)
    throw new SyncError(`tag ${tag} does not exist on ${REMOTE}`);
  if (gitExit('rev-parse', '-q', '--verify', UPSTREAM_MAIN).status !== 0)
    throw new SyncError(`${UPSTREAM_MAIN} is missing: git fetch ${REMOTE}`);
  const target = git('rev-parse', `${tag}^{commit}`);
  const onMain = gitExit('merge-base', '--is-ancestor', target, UPSTREAM_MAIN);
  if (onMain.status === 1)
    throw new SyncError(`${tag} is not on ${UPSTREAM_MAIN}; only release tags of the main line can be synced`);
  if (onMain.status !== 0) throw new SyncError(`git merge-base failed: ${onMain.stderr.trim()}`);
  const current = readRecorded();
  if (!newer(semver(tag), semver(current.tag)))
    throw new SyncError(`${tag} is not newer than the current ${current.tag}`);
  process.stdout.write(
    `Upgrade notes ${current.tag} -> ${tag}:\n\n${upgradeNotes(git('show', `${tag}:${CHANGELOG}`), current.tag, tag)}\n\n`,
  );
  const answer = await ask(`Type ${tag} to confirm you have read the upgrade notes: `);
  if (answer.trim() !== tag) throw new SyncError('upgrade notes not confirmed; nothing changed');
  const merge = gitExit('merge', '--no-ff', '--no-commit', tag);
  if (gitExit('rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0)
    throw new SyncError(`git merge ${tag} did not start a merge:\n${merge.stdout}${merge.stderr}`);
}

function autoResolve({ mergeHead, zones, paths }) {
  for (const p of paths) {
    const { zone } = zoneOf(zones, p);
    if (zone === 'template' && !exists('HEAD', p)) git('rm', '-q', '--', p);
    else if (exists(mergeHead, p)) {
      git('checkout', '--theirs', '--', p);
      git('add', '--', p);
    } else git('rm', '-q', '--', p);
    process.stdout.write(`auto-resolved ${p} (${zone})\n`);
  }
}

/** Dự án đã xoá vùng template (không còn path template nào ở HEAD) → file template upstream mới thêm cũng bị xoá. */
function keepTemplateDeleted(zones) {
  const ours = zList(git('ls-tree', '-r', '-z', '--name-only', 'HEAD'));
  if (ours.some((p) => zoneOf(zones, p).zone === 'template')) return [];
  const incoming = zList(git('ls-files', '-z')).filter((p) => zoneOf(zones, p).zone === 'template');
  for (let i = 0; i < incoming.length; i += GIT_RM_BATCH)
    git('rm', '-q', '-f', '--', ...incoming.slice(i, i + GIT_RM_BATCH));
  return incoming;
}

function regenerate({ mergeHead, zones }) {
  const dropped = keepTemplateDeleted(zones);
  if (dropped.length) process.stdout.write(`kept the template zone deleted: ${dropped.join(', ')}\n`);
  run(process.execPath, ['--run', REGENERATE_SCRIPT]);
  writeFileSync(VERSION_FILE, `${JSON.stringify({ tag: tagOf(mergeHead), commit: mergeHead }, null, 2)}\n`);
  const generated = zones.entries.filter((e) => e.zone === 'generated' && existsSync(e.pattern)).map((e) => e.pattern);
  git('add', '--', VERSION_FILE, ...generated);
}

function verify({ mergeHead }) {
  // Merge chưa commit và HEAD vẫn là phía dự án: kiểm vùng trên một commit tạm của kết quả (không cập nhật ref nào).
  const probe = git('commit-tree', git('write-tree'), '-p', 'HEAD', '-p', mergeHead, '-m', 'upstream:sync verification (not a ref)');
  run(process.execPath, [CHECK_SCRIPT, '--rev', probe]);
  run(process.execPath, ['--run', VERIFY_SCRIPT]);
}

function printManual({ zones, paths }) {
  process.stderr.write(
    'upstream:sync: resolve these conflicts by hand (docs/upstream/merge.md), git add them, then run pnpm upstream:sync --continue\n',
  );
  for (const p of paths) process.stderr.write(`  ${p} (${zoneOf(zones, p).zone})\n`);
}

function printDone({ mergeHead }) {
  const tag = tagOf(mergeHead);
  process.stdout.write(
    [
      `upstream:sync done: ${tag} is merged, regenerated and verified. Nothing is committed. Next:`,
      '  git commit --no-edit',
      `  git push -u origin ${BRANCH_PREFIX}${tag}`,
      '  Open a PR and merge it with "Create a merge commit" — never squash or rebase (docs/upstream/merge.md).',
      '',
    ].join('\n'),
  );
}

async function main(argv) {
  if (argv.length !== 1 || !argv[0]) throw new SyncError('usage: sync.mjs vX.Y.Z | --continue');
  let state = detectState();
  if (argv[0] === '--continue') {
    if (state.kind === 'CLEAN') throw new SyncError('--continue: no upstream merge is in progress');
  } else {
    if (state.kind !== 'CLEAN')
      throw new SyncError('a merge is already in progress; resolve it and run --continue, or git merge --abort');
    await start(argv[0]);
    state = detectState();
  }
  for (;;) {
    switch (state.kind) {
      case 'MERGING_AUTO':
        autoResolve(state);
        break;
      case 'MERGING_MANUAL':
        printManual(state);
        return EXIT_MANUAL;
      case 'REGENERATE':
        regenerate(state);
        break;
      case 'VERIFY':
        verify(state);
        printDone(state); // DONE
        return 0;
      case 'CLEAN':
        throw new SyncError('no merge is in progress after starting one');
      default:
        throw new SyncError(`unrecognized sync state ${state.kind}`);
    }
    state = detectState();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof SyncError || e instanceof ZonesError) process.stderr.write(`upstream:sync: ${e.message}\n`);
    else process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
```
`package.json` — thêm vào `scripts`:
```json
    "upstream:sync": "node tools/upstream/sync.mjs",
    "upstream:regenerate": "pnpm install && pnpm env:example && pnpm build && pnpm openapi:export",
    "upstream:verify": "pnpm install --frozen-lockfile && pnpm lint && pnpm test",
```

- [ ] **Step 4: Chạy xanh**

Run: `pnpm vitest run --project unit test/unit/upstream`
Expected: PASS — `sync.spec.ts` 6/6 cùng mọi test upstream của Task 6–7. Ca UP-11 cho thấy merge của PR sau dừng với `.upstream/version.json` trong danh sách xung đột (R7-16), và sau khi sync lại từ `main` mới thì guard xanh.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write tools/upstream test/unit/upstream package.json
pnpm lint && pnpm typecheck
git add tools/upstream/sync.mjs test/unit/upstream/sync.spec.ts package.json
git commit -m "feat(upstream): upstream:sync state machine (auto-resolved zones, kept-deleted template, regenerate, verify on the merge result)"
```

---
### Task 9: Workflow `upstream-guard.yml` (bộ kiểm của commit upstream; `--self` ở repo upstream; job "upgrade path") + project Vitest `upgrade` (UP-10)

**Files:**
- Create: `.github/workflows/upstream-guard.yml`, `test/upgrade/upgrade-path.spec.ts`
- Modify: `vitest.config.ts` (project `upgrade`), `package.json` (script `test:upgrade`)

**Interfaces:**
- Consumes: `tools/upstream/check.mjs` (Task 6); `createScratchDb` (3A), `baseTestEnv` (SP2 test support), `test/support/infra.global-setup.ts` (Testcontainers Postgres + PgBouncer + Redis + Mailpit); `dist/main.migrate.js`, `dist/main.api.js`.
- Produces:
  - Job `zones`: repo upstream (không có `.upstream/version.json`) → `node tools/upstream/check.mjs --self`; clone → đọc `commit` từ `.upstream/version.json`, `git show <commit>:tools/upstream/check.mjs | node --input-type=module -` với `shell: bash` (có `pipefail`: `git show` hỏng thì bước đỏ, không "xanh vì stdin rỗng").
  - Job `upgrade-path`: chỉ chạy khi PR/push đổi `.upstream/version.json` so với `HEAD^1`: build `HEAD^1` trong `git worktree` và `HEAD`, rồi `UPGRADE_OLD_DIR=<worktree> pnpm test:upgrade`.
  - `test/upgrade/upgrade-path.spec.ts`: database riêng; `node <old>/dist/main.migrate.js up` → `node dist/main.migrate.js up` → `status` rỗng → `dist/main.api.js` tới `/health/ready` 200. Thiếu `UPGRADE_OLD_DIR` → ném ngay lúc thu thập test.
  - Script `"test:upgrade": "vitest run --project upgrade"`.

- [ ] **Step 1: Test upgrade path (fail)**

`test/upgrade/upgrade-path.spec.ts`:
```ts
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTestEnv } from '../support/env.js';
import { createScratchDb, type ScratchDb } from '../support/scratch-db.js';

const OLD_DIR = process.env.UPGRADE_OLD_DIR;
/** Api boot từ `dist` trên DB vừa migrate: rộng hơn nhiều so với thực tế. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const STOP_TIMEOUT_MS = 30_000;

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? ok(a.port) : fail(new Error('no free port'))));
    });
  });

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(`${url} not ready within ${READY_TIMEOUT_MS}ms (last: ${last})`);
}

/**
 * Job "upgrade path" của `.github/workflows/upstream-guard.yml` (spec SP7 §13.4, UP-10): migrate bằng bản build trước
 * merge đồng bộ upstream, rồi bằng bản build sau — đúng thứ tự production gặp (migration upstream timestamp cũ chạy sau
 * migration của dự án, S7-D31) — và api bản mới phải tới `/health/ready`.
 */
describe('upgrade path: previous build, then this build (UP-10)', () => {
  if (!OLD_DIR)
    throw new Error(
      'UPGRADE_OLD_DIR must point at a built checkout of the previous commit (see .github/workflows/upstream-guard.yml, job upgrade-path)',
    );
  const oldDir = resolve(OLD_DIR);
  let scratch: ScratchDb | undefined;
  let env: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    scratch = await createScratchDb('upgrade_path');
    env = { ...process.env, ...baseTestEnv(), DB_NAME: scratch.name };
  });
  afterAll(async () => {
    await scratch?.drop();
  });
  const migrate = (dir: string, cmd: 'up' | 'status') =>
    execFileSync(process.execPath, ['dist/main.migrate.js', cmd], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });

  it('the previous build migrates an empty database, this build applies the rest, nothing stays pending', () => {
    migrate(oldDir, 'up');
    migrate(process.cwd(), 'up');
    expect(migrate(process.cwd(), 'status')).toContain('"migrations":[]');
  });

  it('the api of this build becomes ready on the upgraded database', async () => {
    const port = await freePort();
    const api = spawn(process.execPath, ['dist/main.api.js'], {
      env: { ...env, HTTP_HOST: '127.0.0.1', HTTP_PORT: String(port) },
      stdio: 'inherit',
    });
    const exited = new Promise<void>((r) => api.once('exit', () => r()));
    try {
      await waitReady(`http://127.0.0.1:${port}/health/ready`);
    } finally {
      api.kill('SIGTERM');
      const timer = setTimeout(() => api.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
  });
});
```

`vitest.config.ts` — thêm vào `projects` (sau project `smoke`):
```ts
      {
        extends: true,
        test: {
          name: 'upgrade',
          include: ['test/upgrade/**/*.spec.ts'],
          globalSetup: ['test/support/infra.global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
```
`package.json` — thêm vào `scripts`:
```json
    "test:upgrade": "vitest run --project upgrade",
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm test:upgrade`
Expected: FAIL khi thu thập test — `UPGRADE_OLD_DIR must point at a built checkout of the previous commit …` (fail loud, không skip im lặng).

- [ ] **Step 3: Chạy thật với bản build của `main` trước 3A (thứ tự production thật)**

`old` = commit cha thứ nhất của commit đầu tiên trên `main` (first-parent) có đụng `src/migrations/tenancy/` — tức `main` trước khi 3A merge; bản mới (`HEAD`) thêm 4 migration của 3A lên DB đó:
```bash
OLD_REV=$(git rev-parse "$(git log origin/main --first-parent --format=%H -- src/migrations/tenancy | tail -1)^1")
git worktree add "$TMPDIR/nsb-upgrade-old" "$OLD_REV"
(cd "$TMPDIR/nsb-upgrade-old" && pnpm install --frozen-lockfile && pnpm build)
pnpm build
UPGRADE_OLD_DIR="$TMPDIR/nsb-upgrade-old" pnpm test:upgrade
git worktree remove --force "$TMPDIR/nsb-upgrade-old"
```
Expected: PASS 2/2 — lượt `up` thứ hai áp dụng các migration của 3A (in trong log), `status` in `"migrations":[]`, api tới `/health/ready` 200. `git worktree remove` dọn thư mục tạm (tài nguyên của bước này).

- [ ] **Step 4: Workflow `.github/workflows/upstream-guard.yml`**

```yaml
name: upstream-guard
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read }
concurrency:
  group: upstream-guard-${{ github.ref }}
  cancel-in-progress: true
jobs:
  zones:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        # So cây với commit upstream đã ghi và kiểm quan hệ tổ tiên (spec SP7 §13.2): cần toàn bộ lịch sử.
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version-file: .nvmrc }
      - name: upstream repository — every tracked file is zoned (UP-9)
        if: hashFiles('.upstream/version.json') == ''
        run: node tools/upstream/check.mjs --self
      - name: clone — zones match the recorded upstream commit, checked by the upstream copy of check.mjs
        if: hashFiles('.upstream/version.json') != ''
        # `shell: bash` bật pipefail: nếu `git show` hỏng, bước đỏ thay vì node chạy stdin rỗng rồi exit 0.
        shell: bash
        run: |
          COMMIT=$(node -e "const v = JSON.parse(require('fs').readFileSync('.upstream/version.json', 'utf8')); if (typeof v.commit !== 'string' || !/^[0-9a-f]{40}$/.test(v.commit)) { console.error('.upstream/version.json: commit must be a full 40-character SHA'); process.exit(1); } console.log(v.commit);")
          git cat-file -e "${COMMIT}^{commit}"
          git show "${COMMIT}:tools/upstream/check.mjs" | node --input-type=module -
  upgrade-path:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { fetch-depth: 0 }
      - id: sync
        name: did this change move .upstream/version.json?
        shell: bash
        run: |
          if [ -f .upstream/version.json ] && ! git diff --quiet HEAD^1 HEAD -- .upstream/version.json; then
            echo "changed=true" >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
        if: steps.sync.outputs.changed == 'true'
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        if: steps.sync.outputs.changed == 'true'
        with: { node-version-file: .nvmrc, cache: pnpm }
      - name: build the project side before the merge (HEAD^1)
        if: steps.sync.outputs.changed == 'true'
        shell: bash
        run: |
          git worktree add "$RUNNER_TEMP/previous" HEAD^1
          cd "$RUNNER_TEMP/previous" && pnpm install --frozen-lockfile && pnpm build
      - name: build this commit
        if: steps.sync.outputs.changed == 'true'
        run: pnpm install --frozen-lockfile && pnpm build
      - name: migrate with the previous build, then this build; api ready (UP-10)
        if: steps.sync.outputs.changed == 'true'
        env: { UPGRADE_OLD_DIR: '${{ runner.temp }}/previous' }
        run: pnpm test:upgrade
```
Trên `pull_request`, `actions/checkout` lấy merge commit của PR vào nhánh đích nên `HEAD^1` là phía dự án trước merge; trên `push` vào `main`, `HEAD^1` là `main` trước merge (PR đồng bộ bắt buộc merge commit, spec 13.4 bước 8).

- [ ] **Step 5: Kiểm lệnh của bước "clone" trên clone fixture và cú pháp workflow**

Lệnh của bước "clone" đã được `check.spec.ts` (UP-5b, Task 7) chạy đúng nguyên văn (`git show <commit>:tools/upstream/check.mjs | node --input-type=module -`). Ở repo này (upstream), bước `--self` chạy:
```bash
node tools/upstream/check.mjs --self --rev HEAD
pnpm exec prettier --check .github/workflows/upstream-guard.yml
```
Expected: `upstream:check OK (self)`; prettier xanh. (Workflow được GitHub parse ở PR của Task 13: job `zones` phải xanh ở bước `--self`, job `upgrade-path` xanh với mọi bước sau `sync` bị bỏ qua vì repo upstream không có `.upstream/version.json`.)

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write .github/workflows/upstream-guard.yml test/upgrade vitest.config.ts package.json
pnpm lint && pnpm typecheck
git add .github/workflows/upstream-guard.yml test/upgrade vitest.config.ts package.json
git commit -m "ci(upstream): upstream-guard workflow (upstream copy of the guard, --self upstream, upgrade path job) and the upgrade Vitest project"
```

---

### Task 10: Phát hành upstream bằng release-please `simple` (S7-D10, spec §13.6)

**Files:**
- Create: `release-please-config.json`, `.release-please-manifest.json`, `version.txt`, `CHANGELOG.md`, `.github/workflows/release-please.yml`, `test/unit/upstream/release-config.spec.ts`
- Modify: `.prettierignore`

**Interfaces:**
- Consumes: kết quả spike S7A-2 (Task 1: `version.txt`, `createIfMissing: false`, release-please 17.6.0); `.upstream/zones.json` đã xếp `CHANGELOG.md`, `version.txt`, hai file config vào vùng boilerplate (Task 6).
- Produces: cấu hình phát hành `v0.1.0` khởi đầu; workflow chỉ chạy khi biến repo `BOILERPLATE_UPSTREAM == 'true'` (clone không đặt). `extra-files` cho `deploy/helm/saas-app/Chart.yaml` do 7B thêm khi tạo chart.

- [ ] **Step 1: Test bất biến cấu hình phát hành (fail)**

`test/unit/upstream/release-config.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const Config = z.object({
  'release-type': z.literal('simple'),
  'include-component-in-tag': z.literal(false),
  'include-v-in-tag': z.literal(true),
  'changelog-sections': z.array(z.object({ type: z.string(), section: z.string() })),
  packages: z.object({ '.': z.object({}).passthrough() }),
});
const read = (p: string) => readFileSync(p, 'utf8');

describe('release-please configuration (spec SP7 S7-D10, §13.6)', () => {
  const config = Config.parse(JSON.parse(read('release-please-config.json')));
  const manifest = z.object({ '.': z.string() }).parse(JSON.parse(read('.release-please-manifest.json')));

  it('releases with the simple strategy and never touches package.json (project-owned version)', () => {
    // Đọc văn bản thô: zod bỏ khoá lạ khi parse, nên một `extra-files` trỏ package.json sẽ không hiện trong `config`.
    expect(read('release-please-config.json')).not.toContain('package.json');
    expect(config['changelog-sections'].map((s) => s.type)).toEqual(['feat', 'fix', 'perf', 'refactor', 'docs']);
  });
  it('version.txt, the manifest and the newest CHANGELOG entry agree', () => {
    const version = read('version.txt').trim();
    expect(manifest['.']).toBe(version);
    expect(/^## \[?(\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md'))?.[1]).toBe(version);
  });
  it('the release files are in the boilerplate zone', () => {
    const zones = z.object({ boilerplate: z.array(z.string()) }).parse(JSON.parse(read('.upstream/zones.json')));
    for (const f of ['CHANGELOG.md', 'version.txt', 'release-please-config.json', '.release-please-manifest.json'])
      expect(zones.boilerplate, f).toContain(f);
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/upstream/release-config.spec.ts`
Expected: FAIL — `ENOENT: … release-please-config.json`.

- [ ] **Step 3: File cấu hình và workflow**

`release-please-config.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/v17.6.0/schemas/config.json",
  "release-type": "simple",
  "include-component-in-tag": false,
  "include-v-in-tag": true,
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "refactor", "section": "Refactoring" },
    { "type": "docs", "section": "Documentation" }
  ],
  "packages": { ".": {} }
}
```
`.release-please-manifest.json`:
```json
{ ".": "0.1.0" }
```
`version.txt`:
```
0.1.0
```
`CHANGELOG.md` (ngày = ngày chạy task, `date -u +%F`):
```markdown
# Changelog

## 0.1.0 (<ngày chạy task, YYYY-MM-DD>)

Bản khởi đầu của boilerplate: SP1 core, SP2 identity + notifications, SP3 plan 3A tenancy, SP7 plan 7A (composition module lười, quy trình upstream).

### Upgrade notes

- Bản đầu tiên. Clone thành dự án theo `docs/boilerplate/README.md` mục "Khởi tạo dự án" (`pnpm upstream:init`).
```
(`<ngày chạy task>` là dữ liệu của lần chạy, không phải chỗ trống của plan: điền trước khi commit.)

`.prettierignore` — thêm:
```
# Written by release-please (release PRs) — never hand/tool-formatted
CHANGELOG.md
```
`.github/workflows/release-please.yml`:
```yaml
name: release-please
on:
  push: { branches: [main] }
permissions: { contents: read }
jobs:
  release-please:
    # Chỉ repo upstream đặt biến repo BOILERPLATE_UPSTREAM=true (Settings → Variables); clone không đặt nên job bị bỏ qua.
    if: vars.BOILERPLATE_UPSTREAM == 'true'
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0
        with:
          # Tag tạo bằng GITHUB_TOKEN không kích hoạt workflow khác (release.yml build + ký image theo tag): đặt secret
          # RELEASE_PLEASE_TOKEN (fine-grained PAT hoặc GitHub App token) để tag chạy release.yml (docs/upstream/semver.md).
          token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 4: Kiểm schema của release-please và chạy test**

Run:
```bash
curl -sL https://raw.githubusercontent.com/googleapis/release-please/v17.6.0/schemas/config.json -o "$TMPDIR/release-please-config.schema.json"
pnpm view ajv-cli version
pnpm dlx ajv-cli@5.0.0 validate --spec=draft7 -s "$TMPDIR/release-please-config.schema.json" -d release-please-config.json
pnpm vitest run --project unit test/unit/upstream/release-config.spec.ts test/unit/upstream/self.spec.ts
```
Expected: `pnpm view` in `5.0.0` (khác → dùng bản đó và ghi vào báo cáo task); ajv in `release-please-config.json valid`; test PASS 3/3; `self.spec.ts` ca repo thật xanh sau commit (file mới đã có vùng). Ajv báo `strict mode` về từ khoá lạ trong schema → thêm `--strict=false` (schema của upstream, không phải của repo), ghi vào báo cáo.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write release-please-config.json .release-please-manifest.json .github/workflows/release-please.yml test/unit/upstream/release-config.spec.ts .prettierignore
pnpm lint
git add release-please-config.json .release-please-manifest.json version.txt CHANGELOG.md .github/workflows/release-please.yml test/unit/upstream/release-config.spec.ts .prettierignore
git commit -m "ci(release): release-please simple strategy for upstream releases (v0.1.0, version.txt, CHANGELOG)"
pnpm vitest run --project unit test/unit/upstream/self.spec.ts
```
Expected: lệnh cuối PASS 3/3 (cây đã commit có file mới, mọi file đều đã phân vùng).

---
## Phần E — Tài liệu (spec §6.1, §6.2, §6.3.3, §6.3.4, §13, §21)

### Task 11: Chuyển README sang `docs/boilerplate/README.md` + các mục mới; `docs/upstream/merge.md`, `semver.md`; ADR 0002; áp amendments A1, B1, B5, C2, E1

**Files:**
- Move: `README.md` → `docs/boilerplate/README.md` (`git mv`), rồi sửa
- Create: `README.md` (mới, tên + liên kết), `docs/upstream/merge.md`, `docs/upstream/semver.md`
- Modify: `docs/adr/0002-clone-and-upstream.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md`, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`

**Interfaces:**
- Consumes: tên thật của Task 2–10 (`composeAppModules`, `BOILERPLATE_MODULES`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES`, `markModuleLoaded`, `loadedModules`, `// upstream:template`, `pnpm upstream:check|init|sync`, `docs/upstream/CODEOWNERS.template`, `.dependency-cruiser.app.cjs`, `*.inventory.ts`, `version.txt`, `BOILERPLATE_UPSTREAM`, `RELEASE_PLEASE_TOKEN`).
- Produces: tài liệu khớp với cái 7A ship. Mục README "Tắt module" và "Quy ước cron" là nơi SP4/5/6 trỏ tới (R-X16).

- [ ] **Step 1: Chuyển README và sửa liên kết tương đối**

Run:
```bash
git mv README.md docs/boilerplate/README.md
sed -i 's#](docs/#](../#g; s#](\.env\.example)#](../../.env.example)#g; s#](\.env\.infra\.example)#](../../.env.infra.example)#g' docs/boilerplate/README.md
grep -o "](\([^)]*\))" docs/boilerplate/README.md | sort -u
```
Expected: mọi liên kết dạng `](../adr/…)`, `](../superpowers/…)`, `](../../.env.example)`, `](../../.env.infra.example)`; không còn `](docs/`. (Nếu 3A Task 30 đã thêm liên kết khác dạng `](src/…)`, đổi thành `](../../src/…)` bằng cùng cách và liệt kê lại.)

`README.md` (mới, hạt giống vùng dự án; `upstream:init` thay nó ở clone):
```markdown
# NestJS SaaS Boilerplate

Tài liệu của boilerplate: [docs/boilerplate/README.md](docs/boilerplate/README.md). Clone thành một dự án: mục "Khởi tạo dự án" trong tài liệu đó (`pnpm upstream:init` thay file này bằng README của dự án).
```

- [ ] **Step 2: Sửa phần mở đầu của `docs/boilerplate/README.md`**

Trong đoạn đầu (dòng mô tả sau tiêu đề), thay câu "các module được đăng ký trong `src/app.modules.ts`." bằng: "module nền được khai báo trong `src/boilerplate.modules.ts` và dự án bật/tắt chúng trong `src/app.modules.ts` (mục "Module và feature"). SP7 (plan 7A) bổ sung composition nạp module lười và quy trình nhận cập nhật upstream (`pnpm upstream:init|sync|check`)." Nếu câu gốc đã được 3A sửa (nhắc tenancy), giữ phần 3A thêm, chỉ thay mệnh đề về `src/app.modules.ts`.

- [ ] **Step 3: Thêm các mục mới vào `docs/boilerplate/README.md`**

Chèn ngay trước `## Cách thêm`:
````markdown
## Vùng sở hữu và cập nhật upstream

Mỗi dự án là một clone của boilerplate. Nguồn sự thật của vùng sở hữu là [`.upstream/zones.json`](../../.upstream/zones.json): tiền tố dài nhất thắng (`src/migrations/app/` thắng `src/migrations/`); path không khớp mục nào thuộc dự án.

| Vùng | Ví dụ | Luật |
|---|---|---|
| boilerplate | `src/core/`, `src/modules/`, `src/migrations/` (trừ `app/`, `example/`), `test/` (trừ `features/`), `docs/adr/`, `tools/`, `.github/workflows/ci.yml` | Dự án **không sửa**. Cây ở `HEAD` phải trùng cây ở commit upstream ghi trong `.upstream/version.json`; CI `upstream-guard` chạy bộ kiểm của chính commit upstream đó |
| dự án | `src/features/`, `src/app.modules.ts`, `src/app.plans.ts`, `src/migrations/app/`, `test/*/features/`, `deploy/values/`, `docs/app/`, `README.md` | Dự án toàn quyền |
| template | `src/features/example/`, `src/migrations/example/`, `src/plans.example.ts`, `deploy/values/example.yaml` | Của upstream; dự án chỉ được **xoá** (lúc `upstream:init`), không sửa |
| sinh ra | `.env.example`, `.env.infra.example`, `openapi.json`, `pnpm-lock.yaml` | Xung đột thì sinh lại, không sửa tay |
| chung | `package.json`, `pnpm-workspace.yaml`, `renovate.json`, `.gitignore`, `.dockerignore`, `.gitleaksignore` | `package.json`: giữ nguyên dependency và script của upstream, script mới của dự án có tiền tố `app:`; `pnpm-workspace.yaml`: giữ mọi dòng của upstream, chỉ thêm |

Tuỳ biến phần nền mà không sửa vùng boilerplate:
- config (env), adapter (`@Global()` + `@Optional()`), domain event, hoặc tắt module (mục "Tắt module");
- luật kiến trúc riêng: `.dependency-cruiser.app.cjs` export `{ forbidden: [...] }` (tên luật không trùng luật boilerplate), `pnpm arch` tự nạp;
- khai báo kiểu bổ sung (module augmentation): `src/types/app/`;
- bảng mới trong test chuẩn hoá của boilerplate: `test/integration/features/<f>/<f>.inventory.ts` export `tables` (`[{ table: 'public.<bảng>', columns: [...] }]`), `globalTables`, `definerFunctions`, `definerReadTables`;
- spec, plan, ghi chú của dự án: `docs/app/` (quy trình superpowers của dự án ghi ở `docs/app/superpowers/`; `docs/superpowers/` là lịch sử của upstream);
- workflow `app-*.yml`, service compose thêm ở `compose.override.yaml`, values deploy ở `deploy/values/`;
- migration của dự án chỉ tạo đối tượng của dự án và **chèn dòng** vào bảng catalogue/seed của boilerplate (`permissions`, `plans`, …); không `ALTER`/`DROP` đối tượng boilerplate. Thứ tự timestamp được kiểm **trong từng vùng** (`app/` với `app/`, còn lại với nhau): migration upstream đến muộn với timestamp cũ hơn migration của dự án vẫn chạy (MikroORM chạy mọi migration chưa chạy).

Kiểm tại máy: `pnpm upstream:check` (so **commit** `HEAD`; thay đổi chưa commit chỉ được cảnh báo). Nhận bản mới: `pnpm upstream:sync vX.Y.Z` trên nhánh `chore/upstream-vX.Y.Z`, PR merge bằng **merge commit** — quy trình đầy đủ, squash và cách khôi phục ở [docs/upstream/merge.md](../upstream/merge.md); semver và Upgrade notes ở [docs/upstream/semver.md](../upstream/semver.md).

## Khởi tạo dự án

Chạy một lần, trước lần deploy production đầu tiên:

```bash
git clone --branch vX.Y.Z <URL repo boilerplate> my-app
cd my-app
git switch -c main
pnpm install --frozen-lockfile
pnpm upstream:init --team-core @org/platform --team-app @org/my-app
git remote rename origin upstream
git remote add origin <URL repo dự án>
git commit -m "chore: initialize project from boilerplate vX.Y.Z"
```

`upstream:init` (không commit): ghi `.upstream/version.json` (tag + commit); chép phần hạt giống từ vùng template sang vùng dự án — `src/plans.example.ts` → `src/app.plans.ts`, mỗi `src/migrations/example/*_starter_*.ts` → `src/migrations/app/Migration<timestamp mới>_starter_*.ts` (tên lớp đổi theo); `git rm` vùng template; trong `src/app.modules.ts` xoá mọi dòng kết thúc bằng `// upstream:template` và đổi `./plans.example.js` thành `./app.plans.js`; sinh `.github/CODEOWNERS` từ `docs/upstream/CODEOWNERS.template` (bật "Require review from Code Owners" ở branch protection: đây là lớp chặn cố ý, guard CI là lớp chặn nhầm); thay `README.md` bằng khung của dự án. Sau đó sửa `src/app.plans.ts` và migration gói theo gói thật.

**Seed giá cho billing.** Giá là dữ liệu tiền của dự án nên upstream không ship migration giá. Khi bật billing, dự án tạo `src/migrations/app/Migration<ts>_<tên>_prices.ts` bằng `pnpm exec mikro-orm migration:create --blank --path src/migrations/app --name <tên>_prices`, chèn dòng `billing_prices` theo hình dạng, ràng buộc và vòng đời giá ghi trong README của module billing (SP5) — không chép lại cột ở đây để không có hai nguồn lệch nhau. FK `billing_prices.plan_id → plans(id)` nên migration giá chạy sau migration gói của chính dự án; không `ALTER` bảng của billing.

Nếu dự án đã deploy khi còn migration mẫu (vùng template), xem [docs/upstream/merge.md](../upstream/merge.md) mục "Đã deploy với migration mẫu" trước khi xoá file.

## Module và feature (composition)

`src/boilerplate.modules.ts` (vùng boilerplate) khai báo module nền, mỗi mục là một loader `() => import('./modules/<m>/index.js')`. `src/app.modules.ts` (vùng dự án) gọi composition bằng top-level await:

```ts
import { composeAppModules, type AppFeatures } from './boilerplate.modules.js';
import { CrmModule } from './features/crm/index.js';

const features: AppFeatures = { api: [], worker: [] };
features.api.push(CrmModule.forApi());
features.worker.push(CrmModule.forWorker());

export const APP_MODULES = await composeAppModules({ disable: [], features });
```

`composeAppModules` từ chối lúc boot (app không khởi động, thông điệp nêu tên module) khi: `disable` có khoá trùng/lạ; tắt một module mà module bật khác cần (`MODULE_REQUIRES`); một module bị tắt vẫn bị import (feature hoặc module khác import `index.ts` của nó); một module bật mà `index.ts` không gọi `markModuleLoaded`. Cầu nối tuỳ chọn giữa hai module (`OPTIONAL_BRIDGES`) chỉ nạp khi mọi module của nó cùng bật. Module khác biết một module có bật hay không bằng `loadedModules()` của `core/config`, không import module đó.

Thêm module nền mới (upstream): mục trong `BOILERPLATE_MODULES`, dòng trong `MODULE_REQUIRES`, `markModuleLoaded('<m>')` ở dòng đầu `src/modules/<m>/index.ts`, mọi cron có khoá `<m>.*`, luật config chéo module đăng ký trong `registerCompositionRules` với điều kiện là tập module của nó (`test/integration/composition/module-isolation.spec.ts` kiểm cron và import của mọi module).

## Tắt module

Thêm khoá vào `disable` trong `src/app.modules.ts`. Module bị tắt không bao giờ được import: config (và env bắt buộc) của nó không được kiểm và không có trong `.env.example` (`pnpm env:example`), luật config của nó không đăng ký, queue/job/cron của nó không tồn tại, worker không consume queue của nó; cron tĩnh `static-<m>.*` đã đồng bộ lên Redis từ trước bị worker gỡ lúc khởi động (trong rolling deploy, pod bản cũ khởi động lại có thể đặt lại, pod bản mới kế tiếp gỡ tiếp; hết rollout thì ổn định).

Trước khi tắt: ngừng tạo việc mới cho module (tắt route/feature gọi nó), chờ queue của module rỗng (Bull Board chỉ đọc), rồi mới deploy bản tắt — job còn nằm trong queue của module bị tắt không có ai consume. Migration của module bị tắt **vẫn chạy** (bảng rỗng có RLS, vô hại); bật lại module không phải xử lý thứ tự migration. Giới hạn: cron của module bị tắt mà job của nó nằm trên queue riêng của module đó không được gỡ (worker chỉ thấy queue đã đăng ký); scheduler đó giữ tối đa một job chờ. Mọi cron của boilerplate theo quy ước bên dưới nên không gặp trường hợp này.

## Quy ước cron

Cron tĩnh (`defineCron`) có khoá `<module>.<tên>` (hoặc `core.<tên>`). Job của cron là việc dọn dẹp hoặc tỏa ra (quét các org đến hạn rồi enqueue job theo org) chạy ở queue `maintenance`; việc theo từng org chạy ở queue của module/feature, trong `OrgScope`. Nhờ vậy nhóm worker consume `maintenance` là nơi mọi cron dọn dẹp chạy, và việc nghiệp vụ tồn đọng không làm trễ cron.

## Tạo feature từ mẫu

Mẫu `src/features/example` (tài nguyên `Project` theo org, thêm ở plan 7D) nằm ở vùng template. Chép nó thành feature mới:

1. Chép `src/features/example` → `src/features/<f>`, `src/migrations/example/…` → `src/migrations/app/Migration<ts mới>_<f>_<entity>.ts` (tạo bằng `pnpm exec mikro-orm migration:create --blank --path src/migrations/app --name <f>_<entity>`, rồi dán thân), và ba thư mục test.
2. Đổi **đúng** tập định danh: tên bảng `example_projects`; tên constraint và index `example_projects_*`; hàm definer `example_orgs_with_purgeable_projects` (chữ ký `(p_after, p_limit, p_retention_sec)`, tham số thêm theo tên là khoá của `extraParams`); policy `example_projects_tenant`/`_definer_read`; resource quyền `example_projects`; event `example.project.*`; queue `example`; job `example.projects.purge-org`; cron key (và job quét cùng tên) `example.projects.purge-archived`, class `PurgeArchivedSweepHandler`; tiền tố `jobId` `example-purge`; mã lỗi `example_*`; namespace config `example` và env `EXAMPLE_*`; key tính năng `example.projects` (cờ) và `example.project_count` (quota); participant key `example.projects` (order: một số chưa dùng trong dải 201–999 của registry ở addendum SP3 3D §A4; mẫu dùng 200); metric `example_projects_purged_total`; aggregate type `example_project`; route `projects`; class `Example*`/`Project*`.
3. Đăng ký module trong `src/app.modules.ts` (`features.api.push(...)`, `features.worker.push(...)`).
4. Khai báo inventory ở `test/integration/features/<f>/<f>.inventory.ts`.
5. Đặt giá trị thật cho key tính năng mới trong `src/app.plans.ts`; mẫu dùng `fallback` rộng, feature thật chọn `fallback` an toàn cho nghiệp vụ.
6. Chọn cờ event cho từng event (`audit`, `webhook`; không có mặc định).
7. Quyền mới cấp cho `ADMIN` làm role tuỳ biến trước đó tương đương admin không còn tương đương sau khi nâng cấp: ghi vào Upgrade notes của feature.
8. `pnpm env:example`, `pnpm openapi:export`, chạy đủ pipeline.
9. Xoá phần không cần, kèm phần đi kèm: cron → xoá `defineOrgSweep`, handler quét, và `retireCron(key)`; hàm definer → xoá cả policy `_definer_read` và grant cột; quota → xoá mọi `consumeOrThrow`/`releaseAllocation`, key trong catalogue tính năng và dòng `entitlement_features` (theo vòng đời "deprecate → xoá" nếu đã deploy).
````
Trong mục "## Kiểm tra" của file, thêm dòng lệnh `pnpm upstream:check` vào khối "Kiểm tra đầy đủ trước khi merge" (sau `pnpm test:chaos`).

- [ ] **Step 4: `docs/upstream/merge.md`**

````markdown
# Nhận cập nhật upstream

Spec: `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` §13. Vùng sở hữu: `.upstream/zones.json` và `docs/boilerplate/README.md` mục "Vùng sở hữu và cập nhật upstream".

## Tiền điều kiện

- Remote `upstream` trỏ repo boilerplate (`git remote -v`); cây sạch.
- Nhánh mới từ `main`: `git switch -c chore/upstream-vX.Y.Z main`.
- Merge upstream thường xuyên (mỗi bản minor); không bỏ qua nhiều bản major cùng lúc.

## Chạy

```bash
pnpm upstream:sync vX.Y.Z
```

1. Kiểm tag (dạng `vX.Y.Z`, nằm trên `upstream/main`, mới hơn bản trong `.upstream/version.json`), in mục "Upgrade notes" của mọi bản ở giữa; gõ lại tag để xác nhận đã đọc.
2. `git merge --no-ff --no-commit <tag>`.
3. Tự giải xung đột: vùng boilerplate và file sinh ra lấy bản upstream (upstream xoá thì xoá); vùng template giữ trạng thái đã xoá; nếu dự án đã xoá vùng template, file template mới của upstream cũng bị xoá.
4. Xung đột ở vùng dự án hoặc vùng chung: script dừng (exit 3), in danh sách. Sửa tay theo mục dưới, `git add`, rồi `pnpm upstream:sync --continue`.
5. Sinh lại (`pnpm upstream:regenerate`: install, `env:example`, build, `openapi:export`), ghi `.upstream/version.json`.
6. Kiểm: guard vùng trên kết quả merge, rồi `pnpm upstream:verify` (install `--frozen-lockfile`, lint, test).
7. Script in lệnh commit; mở PR và **merge bằng "Create a merge commit"**. Job CI "upgrade path" của PR chạy migrate bằng bản trước merge rồi bản sau merge và khởi động api.

Mất điện giữa chừng: trạng thái suy ra từ git; chạy `pnpm upstream:sync --continue` hoặc `git merge --abort` rồi làm lại.

## Xung đột tay ở vùng chung

- `package.json`: giữ spec của upstream cho mọi khoá của upstream (dependency, script, `type`, `packageManager`, `engines`, `pnpm`); giữ khoá thêm của dự án; script của dự án có tiền tố `app:`.
- `pnpm-workspace.yaml`: giữ mọi dòng của upstream; chỉ thêm dòng của dự án.
- `renovate.json`: gộp `packageRules` hai bên.
- `.gitignore`, `.dockerignore`, `.gitleaksignore`: hợp hai tập dòng.
- Vùng dự án (`README.md`, `src/app.modules.ts`, …): giữ bản của dự án, áp thay đổi của upstream bằng tay nếu Upgrade notes yêu cầu.

## Squash: phòng, phát hiện, khôi phục

- **Phòng:** ruleset của repo cho `main` chỉ cho phép merge commit (tắt squash và rebase). Nếu dự án cần squash cho PR thường, tạo ruleset riêng chỉ cho merge commit với nhánh `chore/upstream-*`.
- **Phát hiện:** squash làm commit upstream không còn là tổ tiên của `main`; guard báo `upstream commit … is not in history (squash-merged sync PR?)` ở lần chạy trên `main` (lúc đó `main` đã đỏ).
- **Khôi phục sau squash:** trên nhánh mới từ `main`, thêm lại commit của tag làm cha mà không đổi cây:

```bash
git switch -c chore/upstream-ancestry main
git merge -s ours --no-ff vX.Y.Z -m "chore: restore the upstream ancestry of vX.Y.Z"
git diff HEAD~1 HEAD   # phải rỗng
pnpm upstream:check
```
Mở PR, merge bằng merge commit.

## Hai người đồng bộ cùng lúc

Hai nhánh `chore/upstream-*` cùng sửa `.upstream/version.json`: PR merge sau gặp xung đột ở file đó. Không giải tay: `git merge --abort`, tạo lại nhánh từ `main` mới và chạy lại `pnpm upstream:sync vX.Y.Z`.

## Đã deploy với migration mẫu

Nếu production đã chạy migration của vùng template (mẫu `example`) trước khi khởi tạo: hoặc giữ mẫu (không xoá vùng template; `upstream:sync` giữ nó đồng bộ với upstream), hoặc chạy `down` của migration mẫu trên mọi môi trường trước khi xoá file (down từ chối khi còn dữ liệu).

## Bản vá khẩn

Không có đường thoát trong guard. Sửa gấp phần nền đi qua bản vá upstream (`vX.Y.Z+1`, release-please patch) rồi `pnpm upstream:sync`.
````

- [ ] **Step 5: `docs/upstream/semver.md`**

````markdown
# Semver và phát hành của boilerplate

Spec: `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` §13.6.

## Semver

- **Major:** xoá hoặc đổi nghĩa env; xoá hoặc đổi export ở `index.ts` của `core/*` hay `modules/*`; đổi bảng/hàm/role mà feature được phép tham chiếu (`organizations`, `tenancy_users`, `app_current_org`, `sweep_definer`, bảng catalogue nhận dòng seed); đổi chữ ký helper quét của core hoặc API công khai của entitlements mà mẫu dùng; breaking của `oasdiff`; đổi `values.schema.json` theo hướng từ chối values cũ; nâng major Node/Postgres/Kubernetes tối thiểu.
- **Minor:** thêm module, env, export, route, values.
- **Patch:** sửa lỗi không đổi hợp đồng.

## Upgrade notes

Mọi PR có migration ngoài `src/migrations/app/`, env mới hoặc đổi, hoặc đổi export ở `index.ts` của core/module phải có mục `## Upgrade notes` trong mô tả PR. Người duyệt PR phát hành chép vào `CHANGELOG.md` của release dưới tiêu đề `### Upgrade notes` (`pnpm upstream:sync` in đúng mục này). Mỗi migration ghi tác động khoá (bảng khoá, thời gian giữ).

## Phát hành

- release-please (`release-please-config.json`, strategy `simple`): version ở `.release-please-manifest.json` và `version.txt`; **không** chạm `package.json.version` (thuộc dự án). `CHANGELOG.md` do release-please ghi (bỏ khỏi prettier).
- Workflow `release-please.yml` chỉ chạy ở repo upstream: đặt biến repo `BOILERPLATE_UPSTREAM=true`. Clone không đặt biến này.
- Tag do `GITHUB_TOKEN` tạo không kích hoạt workflow khác, nên `release.yml` (build + ký image theo tag) chỉ chạy khi đặt secret `RELEASE_PLEASE_TOKEN` (fine-grained PAT hoặc token GitHub App có quyền contents + pull requests).
- Khởi đầu: sau khi plan 7A merge, người bảo trì gắn tag `v0.1.0` lên commit merge đó và tạo GitHub release `v0.1.0` (một lần, tay), để release-please tính các bản sau từ đó.
- PR phát hành gom commit theo conventional commits; merge PR đó tạo tag `vX.Y.Z` và GitHub release.
````

- [ ] **Step 6: ADR 0002 (E1)**

`docs/adr/0002-clone-and-upstream.md`:
1. Trong "## Hệ quả", thay câu "Chi tiết tự động hoá và xử lý xung đột upstream: Chưa quyết, xem sub-project 7." bằng "Chi tiết tự động hoá và xử lý xung đột upstream: mục "Cập nhật SP7 (7A)" dưới đây."
2. Thêm ngay trước "## Phương án đã loại":
```markdown
## Cập nhật SP7 (7A) (<ngày áp, YYYY-MM-DD>)

- **Vùng sở hữu máy đọc được:** `.upstream/zones.json` (boilerplate, dự án, template, sinh ra, chung; tiền tố dài nhất thắng; `projectSeed` = `src/app.modules.ts`, `README.md`: tập duy nhất của vùng dự án mà upstream được track). `tools/upstream/check.mjs --self` ở CI upstream bắt file chưa phân vùng.
- **Guard so cây (S7-D8):** với mọi path vùng boilerplate, cây ở `HEAD` phải trùng cây ở commit upstream ghi trong `.upstream/version.json`, và commit đó phải là tổ tiên của `HEAD` (squash bị bắt). Workflow `upstream-guard` chạy bản `check.mjs` **của commit upstream** (`git show <commit>:tools/upstream/check.mjs | node --input-type=module -`), đọc `zones.json` từ commit upstream: sửa guard hay vùng ở `HEAD` không nới được luật. Vùng template: path còn tồn tại phải trùng upstream, path đã xoá bỏ qua. `package.json`/`pnpm-workspace.yaml` kiểm theo khoá.
- **Không có đường thoát (S7-D9):** sửa gấp phần nền đi qua bản vá upstream.
- **Công cụ:** `pnpm upstream:init` (khởi tạo clone: version, chép hạt giống template → dự án, xoá vùng template, CODEOWNERS), `pnpm upstream:sync vX.Y.Z` (state machine suy ra từ git: tự giải vùng boilerplate/template/sinh ra, dừng ở vùng dự án/chung, sinh lại, kiểm trên kết quả merge), `pnpm upstream:check`. Node ESM thuần, không dependency.
- **Squash:** phòng bằng ruleset chỉ merge commit; phát hiện bằng kiểm tổ tiên; khôi phục bằng `git merge -s ours --no-ff <tag>` (cây không đổi).
- **Phát hành (S7-D10):** release-please `simple` (`version.txt`, không chạm `package.json.version`), tag `vX.Y.Z` + `CHANGELOG.md` với mục "Upgrade notes".
- **Composition lười (S7-D7):** "bỏ module" = không import (`composeAppModules({ disable })`), vì import một module là đăng ký config/queue/job/cron của nó.
- **Thứ tự migration theo vùng (S7-D31):** migration upstream đến muộn với timestamp cũ hơn migration dự án vẫn chạy (MikroORM chạy mọi migration chưa chạy; test UP-10); dự án không `ALTER`/`DROP` đối tượng boilerplate.
- Quy trình: `docs/upstream/merge.md`, `docs/upstream/semver.md`.
```
3. Sửa đoạn "Trạng thái SP1: …" thêm câu cuối: "Từ SP7 (7A): có `CHANGELOG.md` (`v0.1.0`), guard CI `upstream-guard` và công cụ `tools/upstream/`."

- [ ] **Step 7: Amendments A1, B1, B5, C2**

Tìm theo nội dung (không theo số dòng); không thấy nguyên văn → **dừng**, đối chiếu `origin/main`, báo.
1. **A1** — `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` §1.1: thay hai gạch đầu dòng
   "- `core/`, `modules/`: thuộc boilerplate, dự án **không sửa**. CI của dự án báo lỗi nếu PR sửa hai thư mục này mà không phải commit merge từ upstream." và "- `features/`, `app.modules.ts`, `src/migrations/app/`: thuộc dự án."
   bằng:
   "- Vùng sở hữu máy đọc được ở `.upstream/zones.json` (spec SP7 §6.1): boilerplate, dự án, template, sinh ra, chung; tiền tố dài nhất thắng; upstream chỉ track `projectSeed` (`src/app.modules.ts`, `README.md`) trong vùng dự án.
   - CI của dự án (`upstream-guard`) so cây vùng boilerplate ở `HEAD` với cây ở commit upstream ghi trong `.upstream/version.json` (commit đó phải là tổ tiên của `HEAD`), bằng bộ kiểm của chính commit upstream. README của boilerplate ở `docs/boilerplate/README.md`.
   - Composition: `src/boilerplate.modules.ts` khai báo module nền bằng loader; `src/app.modules.ts` gọi `composeAppModules({ disable, features })` nạp module lười ("bỏ module" = không import, S7-D7)."
   Thêm vào mục "Trạng thái" đầu file đúng một dòng: `- Cập nhật ngày <ngày áp, YYYY-MM-DD> theo spec SP7 (plan 7A): §1.1.`
2. **C2** — `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md` §5.15: sau câu "`.env.example` sinh lại bằng `pnpm env:example`." thêm: " (SP7 7A: script nạp `src/app.modules.ts`, nên `.env.example` gồm đúng config của các module đang bật trong composition, kể cả feature; module bị tắt không có dòng nào.)"
3. **B1** — `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` §6.13, cuối đoạn "**Thứ tự merge của 3C ∥ 3D (INT2-N-3):** …": thêm câu "(SP7 7A, S7-D31: luật "timestamp lớn hơn migration mới nhất của `main`" áp **trong từng vùng** — `src/migrations/app/` so với nhau, mọi thư mục khác so với nhau; không so chéo, vì migration upstream đến muộn ở clone có timestamp cũ hơn migration của dự án.)"
4. **B5** — cùng file §22.1, cuối gạch đầu dòng "**README:** …": thêm câu "(SP7 7A: README của boilerplate ở `docs/boilerplate/README.md`; `order` participant theo registry ở addendum 3D §A4, không theo quy ước của SP7 r0.)"

Run:
```bash
git diff --stat docs/
grep -n "Chưa quyết, xem sub-project 7" docs/adr/0002-clone-and-upstream.md
grep -n "mà không phải commit merge từ upstream" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
```
Expected: diff chỉ ở các file của task; hai lệnh `grep` không in gì (câu cũ đã được thay).

- [ ] **Step 8: Kiểm và commit**

Run:
```bash
pnpm exec prettier --write README.md
pnpm lint
node tools/upstream/check.mjs --self --rev "$(git write-tree)"
```
Expected: lint xanh; lệnh cuối kiểm **index** (đã `git mv`/`git add`): `upstream:check OK (self)` — `docs/boilerplate/`, `docs/upstream/` đều thuộc vùng boilerplate, `README.md` là hạt giống. (`--rev` nhận tree-ish: `--self` chỉ đọc `zones.json` và `ls-tree` của nó.) Trước lệnh cuối chạy `git add README.md docs/`.
```bash
git add README.md docs/boilerplate docs/upstream docs/adr/0002-clone-and-upstream.md docs/superpowers/specs
git commit -m "docs: move the boilerplate README to docs/boilerplate; upstream process, composition, disabling modules; ADR 0002 and SP7 7A amendments"
```

---
## Phần F — Prod-like, bàn giao

### Task 12: Prod-like #2 trên image production; tập dượt khởi tạo clone từ nhánh (init → guard → pipeline); đo image, ghi ADR 0013

**Files:**
- Modify: `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: mọi task 1–11; smoke harness `test/smoke/*` (image `${APP_IMAGE_REPO}:${project}` do `smoke.global-setup.ts` build), `test/smoke/composition.smoke.spec.ts` (Task 4).
- Produces: bằng chứng prod-like cuối plan; bằng chứng một clone khởi tạo từ cây của nhánh xanh guard và pipeline (phần của UP-13 không cần chart; UP-13 đầy đủ với `kind-smoke` thuộc 7B); mục "Số đo SP7 (7A)" trong ADR 0013.

- [ ] **Step 1: Smoke prod-like đầy đủ**

Run: `pnpm build && pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer, rate limit bật), migrate; mọi file smoke PASS (`core`, `auth-email`, `dashboard`, `tenancy`, `composition`); log api/worker JSON, không `error`, không secret; `/health/ready` 200; teardown `down -v` sạch (`docker compose -p nsb-smoke ps -a` rỗng). Image `nestjs-saas-boilerplate:nsb-smoke` còn lại để đo ở Step 3.

- [ ] **Step 2: Tập dượt khởi tạo một clone từ cây của nhánh**

Trong thư mục tạm, không đụng repo làm việc, không push (tag chỉ tồn tại trong clone tạm):
```bash
REHEARSAL="$TMPDIR/nsb-rehearsal"
rm -rf "$REHEARSAL"
git clone -q --branch sp7a-modules-upstream . "$REHEARSAL"
cd "$REHEARSAL"
git config user.name Rehearsal && git config user.email rehearsal@example.test
git tag v0.1.0
git switch -q -c main
pnpm install --frozen-lockfile
node tools/upstream/init.mjs --team-core @acme/platform --team-app @acme/app
git commit -q -m "chore: initialize project from boilerplate v0.1.0"
node tools/upstream/check.mjs
pnpm lint && pnpm arch && pnpm typecheck && pnpm test
pnpm env:example && git diff --exit-code .env.example .env.infra.example
cd - && rm -rf "$REHEARSAL"
```
Expected: `init` in "upstream:init done for v0.1.0 (0 template file(s) removed)" (vùng template chưa có file nào ở 7A); guard `upstream:check OK (HEAD)`; lint, arch, typecheck, unit xanh trên cây đã khởi tạo (không cần sửa file boilerplate nào); `.env.example` không lệch. `rm -rf` dọn thư mục tạm ở cả nhánh xanh lẫn đỏ (chạy tay nếu một lệnh giữa chừng dừng).

- [ ] **Step 3: Đo image đúng cách ADR 0013 đang dùng**

Run (Git Bash, cùng máy với các dòng trước trong ADR 0013):
```bash
IMG=nestjs-saas-boilerplate:nsb-smoke
docker history --format '{{.Size}}' "$IMG" | node -e "
  const units = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };
  let total = 0;
  for (const line of require('fs').readFileSync(0, 'utf8').trim().split('\n')) {
    const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(line.trim());
    if (m) total += Number(m[1]) * units[m[2]];
  }
  console.log('uncompressed total layers MB', (total / 1e6).toFixed(1));
"
docker image inspect --format '{{.Size}}' "$IMG"
```
Expected: tổng layer chưa nén ≤ 400 MB (vượt → dừng: pipeline coi là đỏ); chênh so với dòng mới nhất trong ADR 0013 (3A) gần 0, vì 7A không thêm dependency nào (chỉ thêm vài KB `dist/` và `tools/` không vào image: `.dockerignore` quyết định — kiểm `docker run --rm "$IMG" -e "console.log(require('fs').existsSync('tools'))"` và ghi kết quả).

- [ ] **Step 4: Ghi ADR 0013**

`docs/adr/0013-build-toolchain.md` — thêm mục mới ngay sau mục số đo mới nhất (của 3A, "Số đo SP3 (3A)"):
```markdown
### Số đo SP7 (7A) (<ngày đo>)

Đo sau `pnpm test:smoke` xanh của Task 12 trên HEAD nhánh `sp7a-modules-upstream`, cùng máy và phương pháp với dòng SP3 (3A). 7A không thêm dependency; thay đổi là composition (`src/boilerplate.modules.ts`), công cụ upstream (`tools/upstream/`, <có/không> nằm trong image theo `.dockerignore`) và tài liệu.

| Chỉ số | SP3 (3A) | SP7 (7A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | <số của dòng 3A> MB | <số đo> MB | <±x> MB |
| Image nén | <số của dòng 3A> MB | <số đo> MB | <±x> MB |
| Mốc ≤ 400 MB chưa nén (§13.3) | | <ĐẠT/KHÔNG ĐẠT>, dư <n> MB | |
```
Thay mọi `<…>` bằng số đo thật của Step 3 và số của dòng 3A trong chính file (dấu phẩy thập phân như văn bản ADR). Đây là dữ liệu đo, không phải chỗ trống của plan: chỉ commit sau khi có số.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0013-build-toolchain.md
git commit -m "docs(adr): record the SP7 (7A) image size in ADR 0013"
```

---

### Task 13: Kiểm chứng toàn nhánh, push, một PR cho 7A, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–12.
- Produces: nhánh `sp7a-modules-upstream` trên `origin`, một PR `sp7a-modules-upstream → main` với mọi check CI xanh (gồm workflow mới `upstream-guard`: job `zones` chạy `--self`, job `upgrade-path` bỏ qua các bước build vì repo upstream không có `.upstream/version.json`; `release-please` không chạy trên PR).

- [ ] **Step 1: Pipeline đầy đủ trên máy (cùng thứ tự như CI)**

Run:
```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm arch
pnpm typecheck
pnpm test
pnpm build
pnpm test:int
pnpm test:chaos
pnpm test:smoke
pnpm env:example && git diff --exit-code .env.example .env.infra.example
pnpm openapi:export && git diff --exit-code openapi.json
node tools/upstream/check.mjs --self
```
Expected: mọi lệnh exit 0. Đọc output thật:
- `pnpm test` gồm `test/unit/upstream/*` (repo git tạm thật: UP-1…UP-9, UP-11), `test/unit/composition/*` (UP-12, UP-12d), `migration-order.spec.ts` theo vùng;
- `pnpm test:int` gồm `migrations.spec.ts` (up → down → up và sweep S2-R57, không đổi), `normalization-inventory.spec.ts` qua glob, `test/integration/composition/*` (UP-12b, UP-12c), `out-of-order-migrations.spec.ts` (UP-10);
- `pnpm test:smoke` có `composition.smoke.spec.ts`;
- hai `git diff --exit-code` không có diff; `--self` in `upstream:check OK (self)`.
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1.

- [ ] **Step 2: Kiểm tay trước khi push**

Run:
```bash
git fetch origin main
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
git worktree list
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không file tạm, không secret; không còn worktree tạm của Task 9 (`nsb-upgrade-old`). `main` đã đổi trong lúc làm (ví dụ 4A hoặc 6.0 merge trước) → rebase, giải xung đột ở `src/boilerplate.modules.ts`/`src/app.modules.ts` theo Task 3 Step 6 (D1) nếu là 4A, chạy lại Step 1.

- [ ] **Step 3: Push và mở PR (chỉ khi Sếp đã cho phép push/PR cho plan này)**

Run:
```bash
git push -u origin sp7a-modules-upstream
gh pr create --base main --head sp7a-modules-upstream --title "SP7 plan 7A: lazy module composition and the upstream process" --body-file "$TMPDIR/sp7a-pr.md"
```
Nội dung `$TMPDIR/sp7a-pr.md` (viết trong scratchpad, không commit):
```markdown
## SP7 plan 7A — lazy module composition and the upstream process

Spec: docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md (r2; §20 row 7A)
Plan: docs/superpowers/plans/2026-09-29-sp7a-modules-upstream.md
ADR: 0002 (spike S7A-1…3 + SP7 7A update), 0013 ("SP7 (7A)" image size)

### Contents
- composition: `src/boilerplate.modules.ts` (loaders, `MODULE_REQUIRES`, empty `OPTIONAL_BRIDGES`), `composeAppModules`/`composeFrom`, `app.modules.ts` top-level await, `markModuleLoaded`/`loadedModules` (core/config), static crons of disabled modules removed (core/scheduler), cross-module config rules per enabled set, `gen-env-example` from the composition
- upstream: `.upstream/zones.json`, `tools/upstream/{check,init,sync,zones}.mjs`, `upstream-guard.yml` (upstream copy of the guard; `--self` upstream; upgrade-path job + `test:upgrade`), release-please `simple` (`v0.1.0`)
- project extension points: feature inventories (glob), `.dependency-cruiser.app.cjs`, migration order per zone
- docs: README moved to `docs/boilerplate/README.md`; `docs/upstream/{merge,semver}.md`, `CODEOWNERS.template`; amendments A1, B1, B5, C2, E1

### Verification (real commands and results)
<paste the summary of every Step 1 command: tests passed per project, durations>

### Image (ADR 0013)
<uncompressed / compressed / delta vs SP3 (3A), exactly as recorded in Task 12>

### After merge (maintainer, manual)
- Tag `v0.1.0` on the merge commit and create the GitHub release `v0.1.0`.
- Set the repository variable `BOILERPLATE_UPSTREAM=true` and the secret `RELEASE_PLEASE_TOKEN` (docs/upstream/semver.md).

### Residual risk
- The clone-side jobs of `upstream-guard` (upstream copy of the guard, upgrade path) first run in a real clone; their commands are exercised by UP-5b (fixture clone) and by `pnpm test:upgrade` run locally against the pre-3A build.
- A disabled module's cron whose job sits on the module's own queue is not removed (only registered queues are listed); it keeps at most one waiting job (BullMQ schedules the next run only when a worker processes the job). Every boilerplate cron follows the `maintenance` convention.
```
Thay các khối `<…>` bằng output thật của Step 1 và số của Task 12 trước khi chạy `gh pr create` (dữ liệu của lần chạy, không phải chỗ trống của plan).

- [ ] **Step 4: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh: `checks` (lint, arch, typecheck, test, test:int), `openapi` (+ oasdiff: không đổi API), `secrets-and-deps`, `codeql`, `image`, `upstream-guard / zones` (bước `--self`), `upstream-guard / upgrade-path` (các bước build bỏ qua). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 5: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image, việc sau merge (tag `v0.1.0`, biến `BOILERPLATE_UPSTREAM`, secret `RELEASE_PLEASE_TOKEN`), rủi ro còn lại. Không merge (merge là quyết định của Sếp).

---

## Self-review

### 1. Độ phủ spec (mục 20 hàng 7A và các dòng "7A" của mục 6.5, 19, 21)

| Hạng mục 7A của spec | Task |
|---|---|
| `src/boilerplate.modules.ts`: loader lười, `BOILERPLATE_MODULES`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES` rỗng (R-X13), `composeAppModules`/`composeFrom` (6.2 bước 1–5, 2b) | 3 |
| `markModuleLoaded`/`loadedModules` export ở `core/config` (C1, R-X13, R-X16); dòng đầu identity, notifications, tenancy | 2, 3 |
| `composition.config.ts` theo tập module bật (`registerCompositionRules`) | 3 |
| Gỡ cron `static-<m>.*` của module bị tắt (`setDisabledModuleKeys`/`disabledModuleKeys`, `StaticScheduler.sync`) | 2, 4 |
| `gen-env-example` đọc composition (amendment C2) | 3, 11 |
| `app.modules.ts` top-level await (O-14) | 1 (spike), 3, 4 (smoke) |
| Cặp 7A ∥ 4A: plan merge sau đặt mục `entitlements` (amendment D1, X-7) | 3 Step 6 (có điều kiện), 13 Step 2 |
| `zones.json` + `projectSeed` (S7-D36), `tools/upstream/check.mjs` chạy từ commit upstream (13.2), kiểm theo khoá (13.3), `--self` (UP-9) | 6, 7 |
| `tools/upstream/init.mjs` (6.3.4, S7-D36; không chép giá, R-X19) | 7 |
| `tools/upstream/sync.mjs` (13.4, state machine 8.2, `nextStep` vét cạn → `switch` với nhánh `default` ném) | 8 |
| `upstream-guard.yml` + job "upgrade path" (13.4) | 9 |
| release-please `simple` + CHANGELOG `v0.1.0`; O-16 đọc lại tên file version | 1 (spike S7A-2), 10 |
| `docs/upstream/*` (squash: phòng, phát hiện, khôi phục), `CODEOWNERS.template` | 7, 11 |
| `.dependency-cruiser.app.cjs` hook (M5) | 5 |
| `normalization-inventory` nạp glob (S7-D28) | 5 |
| Chuyển README (gồm "Tắt module", quy ước cron S7-D34, chép mẫu 6.3.3, khởi tạo + seed giá) | 11 |
| ADR 0002 (E1) | 1, 11 |
| Amendments A1, B1 (thứ tự migration theo vùng, cả code `migration-order.spec.ts`), B5, C2 | 5 (B1 code), 11 |
| UP-1, UP-2, UP-3, UP-4, UP-5 (a, b) | 7 (`check.spec.ts`) |
| UP-6, UP-6b, UP-7, UP-8, UP-11 | 8 |
| UP-9 | 6 (`self.spec.ts`) |
| UP-10 | 5 (cơ chế, `out-of-order-migrations.spec.ts`), 9 (job + chạy thật với bản trước 3A) |
| UP-12, UP-12d | 3 |
| UP-12b, UP-12c | 4 |
| Tiêu chí 6 (quy trình upstream + tắt module), 7 (phát hành) | 3–11 |
| Tiêu chí 10 (pipeline đầy đủ mỗi plan, prod-like) | 4, 12, 13 |
| Race R7-16, R7-17 | 8 (UP-11), 2 + 4 (UP-12b) |

### 2. Race của 7A → cơ chế → test

| Race | Cơ chế | Test (task) |
|---|---|---|
| R7-16 hai người chạy `upstream:sync` trên hai nhánh | Git: PR merge sau xung đột ở `.upstream/version.json`, phải `merge --abort` và sync lại từ `main` mới; guard kiểm tổ tiên | UP-11 (8) |
| R7-17 tắt module ∥ rolling deploy (pod cũ còn bật module, sync cron lúc boot) | `StaticScheduler.sync()` chỉ chạy lúc boot: pod mới gỡ `static-<m>.*`, pod cũ khởi động lại có thể upsert lại, pod mới kế tiếp gỡ tiếp; hết rollout thì ổn định. Job cron sinh ra trong khoảng đó nằm ở queue không ai consume (bản mới) hoặc được bản cũ chạy như trước | UP-12b ba pha (4), unit `static-scheduler.spec.ts` (2) |
| Hai worker bản mới cùng gỡ một `static-<m>.*` | `remove` của scheduler đã mất là no-op trong BullMQ, giống đường `retireCron` có sẵn (SP1 `parallel syncs converge…`) | `scheduler.spec.ts` hiện có (2) |
| `sync` bị ngắt giữa chừng | Không có file trạng thái: trạng thái suy lại từ git mỗi lần chạy (`MERGE_HEAD`, path chưa merge, `version.json` so với `MERGE_HEAD`) | UP-8 (`--continue` sau dừng), Review Focus 3 (8) |

### 3. Quét chỗ trống

Các `<…>` còn lại là **dữ liệu của lần chạy**, không phải thiết kế còn thiếu: ngày trong `CHANGELOG.md` (Task 10), ngày áp amendments (Task 11), số đo image (Task 12, chỉ commit sau khi đo), output kiểm chứng trong mô tả PR (Task 13). Không có "TBD", "tương tự Task N", hay bước mô tả mà không có code. Task 3 Step 6 là nhánh có điều kiện (4A merge trước hay sau), có đủ code cho nhánh áp dụng.

### 4. Nhất quán tên và kiểu

- `core/config`: `markModuleLoaded(key)`, `loadedModules(): ReadonlySet<string>` (Task 2) — dùng ở 3, 4.
- `core/scheduler`: `setDisabledModuleKeys(keys)`, `disabledModuleKeys()`, `cronKeyModule(key)` (Task 2) — dùng ở 3 (`composeFrom` bước 5), 2 (`sync`).
- `src/boilerplate.modules.ts`: `ModuleImport`, `ModulePair`, `AppFeatures`, `ComposeOptions<K>`, `ModuleEntry<K>`, `OptionalBridge<K>`, `Composition<K>`, `BOILERPLATE_MODULES`, `BoilerplateModuleKey`, `MODULE_REQUIRES`, `OPTIONAL_BRIDGES`, `composeFrom`, `composeAppModules` (Task 3) — dùng ở 4 (probe, entry), 11 (README).
- `registerCompositionRules(enabled: ReadonlySet<string>)` (Task 3).
- Công cụ: `check.mjs [--rev] [--self]` (6), `zones.mjs` `parseZones`/`zoneOf`/`ZonesError` (7), `init.mjs --team-core --team-app` (7), `sync.mjs vX.Y.Z | --continue` (8); scripts `upstream:check|init|sync|regenerate|verify`, `test:upgrade` (6–9).
- Test support: `Repo`, `createUpstream`, `releaseUpstream`, `cloneAtTag`, `initProject`, `removeRepo`, `FIXTURE_APP_MODULES(_AFTER_INIT)` (6); `parseFeatureInventory`, `mergeAnalysedColumns`, `NormalizationEntry`, `FeatureInventory` (5); `migrationZone`, `migrationsNotNewerThanZone` (5).
- Hằng/marker: `// upstream:template` (3, 7, 11), `COMPOSITION_PROBE ` (4), `@TEAM_CORE`/`@TEAM_APP` (7).

### 5. Hạng mục không thuộc 7A (theo spec) — không đặt trong plan này

- **Luật config theo vai trò (C2 của mục 6.5; amendment C3)**, **metadata `.meta({ secret: { roles } })` + `secretFieldsOf` + `pnpm chart:secrets`** (S7-D33): spec gán cho **7B** ở ba chỗ (mục 6.5 cột "Plan" = 7B cho `database.config.ts`, `notifications.config.ts`, `identity.config.ts`, `core/config/` S7-D33, `gen-chart-secrets.ts`; mục 20 hàng 7B; mục 21 C3 ghi "(code core + identity + notifications, 7B)"). 7A không chạm chúng; 7B phụ thuộc 7A (script sinh secret nạp `BOILERPLATE_MODULES` của Task 3).
- `extra-files: deploy/helm/saas-app/Chart.yaml` của release-please: 7B (chart chưa có).
- UP-13 đầy đủ (CI boilerplate gồm `kind-smoke` trên cây đã `init`): 7B; 7A chỉ tập dượt init → guard → lint/arch/typecheck/unit (Task 12 Step 2).
- `rls-catalog.spec.ts` nạp inventory (B2) và luật depcruise `features-only-public-api-of-other-features`: 7D.
- Nội dung vùng template (mẫu `example`, `src/plans.example.ts`, `…_starter_plans`): 7D và 4A; 7A chỉ định nghĩa vùng và cách `init`/`sync` xử lý nó (kiểm bằng fixture).

### 6. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Top-level await trong `app.modules.ts` qua mọi công cụ** (O-14): Task 1 Step 2 chạy thật bốn đường; không đạt thì dừng (không có fallback trong spec).
2. **Xung đột ở `.upstream/version.json` khi merge PR đồng bộ thứ hai (UP-11)**: dựa vào merge `ort` của git thấy hai phía cùng sửa một dòng so với base; test chạy git thật và khẳng định danh sách xung đột. Nếu git gộp được (không xung đột), guard vẫn đúng (tag mới hơn là hậu duệ của tag cũ) nhưng R7-16 phải viết lại — dừng và báo.
3. **`node --run` chạy script `package.json` trên Windows và Linux** (Node 24): `sync.spec.ts` chạy trên máy dev Windows và CI Ubuntu.
4. **Tên thật của 3A** (`TenancyModule` ở `src/modules/tenancy/index.ts`, cron `tenancy.orgs.purge`): lấy từ Produces của plan 3A; Task 1 Step 1 kiểm trước khi làm.
5. **Tên thật của 4A nếu 4A merge trước** (`EntitlementsModule.forApi(plans)`, `PlanCatalogue`, export của `src/plans.example.ts`): Task 3 Step 6 đối chiếu với code đã merge. Ghi chú cho plan 4A/7D: `init.mjs` chép `src/plans.example.ts` nguyên văn sang `src/app.plans.ts` và chỉ đổi đường dẫn import trong `app.modules.ts`, nên `app.modules.ts` import đúng tên mà `plans.example.ts` export (spec SP4 dòng 391 gọi nó `examplePlans`, SP7 §6.2 gọi `appPlans`: bản nào cũng chạy, miễn nhất quán giữa hai file).
6. **Đã đối chiếu lúc viết plan (không còn là giả định):** `version.txt` + `createIfMissing: false` của strategy `simple`, SHA tag v5.0.0 `45996ed…`, input `config-file`/`manifest-file`/`token` (action v5.0.0); schema config release-please v17.6.0; công thức tên migration của MikroORM; timer `unref()` của `ConditionalModule`; BullMQ thêm lần chạy kế của scheduler khi worker xử lý job; `process.argv.slice(2)` khi chạy từ stdin; `hashFiles` chỉ dùng được ở `if` cấp bước (sau checkout); `defineCron`/`retireCron`/`cronRegistry`/`staticCronId` và `JobScheduler.listIds` quét `queueRegistry()`; `ANALYSED_COLUMNS` và `import.meta.glob` của test; `.dependency-cruiser.cjs` là `module.exports = {…}` với `tsPreCompilationDeps: true`; `migration-order.spec.ts` so với `origin/main`.
