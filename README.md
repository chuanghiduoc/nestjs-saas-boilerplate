# NestJS SaaS Boilerplate — lõi SaaS NestJS (sub-project 1: core + hạ tầng job)

Modular monolith NestJS 12: một codebase, một image, ba vai trò (`api`, `worker`, `migrate`). Sub-project 1 dựng phần `src/core/`: config, context, database (MikroORM + RLS), outbox/inbox, events, queue (BullMQ), scheduler, http (problem+json, phân trang, ETag, Merge Patch, idempotency, rate limit, OpenAPI), resilience (HTTP ra ngoài chặn SSRF), security (mã hoá field), observability (OpenTelemetry) và health. Chưa có module nghiệp vụ: `src/app.modules.ts` để trống.

Thiết kế: [spec kiến trúc](docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md), [spec sub-project 1](docs/superpowers/specs/2026-09-24-sp1-core-job-infrastructure-design.md), các ADR trong [`docs/adr/`](docs/adr/).

## Yêu cầu

- Node 24 LTS. `.nvmrc` ghi đúng bản Node của image (`v24.21.0`).
- pnpm qua corepack: `corepack enable`. Phiên bản pnpm lấy từ trường `packageManager` của `package.json`.
- Docker (Docker Compose v2).

## Chạy dev

```bash
pnpm install
pnpm env:example                                  # sinh lại .env.example và .env.infra.example từ schema
cp .env.example .env && cp .env.infra.example .env.infra   # điền secret, xem ghi chú bên dưới
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env up -d
pnpm build && node --env-file=.env dist/main.migrate.js up
pnpm start:dev --env-file .env
```

Ghi chú:

- App **không tự đọc `.env`** (`ignoreEnvFile: true`), nên lệnh chạy trên host phải nạp env: `node --env-file=.env …` cho `dist/*.js`, và `pnpm start:dev --env-file .env` (option `--env-file` của `nest start`).
- `docker compose … up -d` không có profile chỉ chạy hạ tầng: Postgres, PgBouncer, Redis. Mọi cổng chỉ bind `127.0.0.1`; cổng phía host lấy từ `.env.infra`.
- `.env.infra` là config của hạ tầng compose (superuser Postgres, `REDIS_PASSWORD`, cổng host, `COMPOSE_REDIS_URL`), chỉ dùng để nội suy, không bao giờ vào container app. `.env` là config của app; Postgres cũng lấy mật khẩu của các role app (`DB_APP_PASSWORD`, `DB_RELAY_PASSWORD`, `DB_OWNER_PASSWORD`) từ đây.
- Khi chạy app trên host, `.env` cần trỏ về cổng host: ví dụ `DB_HOST=localhost`, `DB_MIGRATION_HOST=localhost`, `DB_MIGRATION_PORT` = cổng Postgres (migration luôn đi thẳng Postgres, không qua PgBouncer), `REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:<cổng Redis>`.
- `FIELD_ENCRYPTION_KEYS` và `FIELD_ENCRYPTION_ACTIVE_KID` bắt buộc ở mọi vai trò. Keyring là JSON `{"<kid>":"<base64 của đúng 32 byte>"}`, kid khớp `[a-z0-9]{1,16}`.
- Worker trên host: `node --env-file=.env --import ./dist/instrumentation.js dist/main.worker.js` (cần `DB_RELAY_PASSWORD`; `WORKER_QUEUES` rỗng = mọi queue đã đăng ký).
- Health: `GET /health/live`, `GET /health/ready`. API ở cổng `HTTP_PORT` (mặc định 3000); worker có server health riêng ở `WORKER_HEALTH_PORT` (mặc định 3001).
- Lệnh migrate: `up` (mặc định), `status`, `down <tên migration | 0>`; `node dist/main.migrate.js --help` không cần env.

### Chạy ba vai trò bằng image

```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env --profile app up -d --build
```

Profile `app` build image từ `Dockerfile` (base image pin theo digest trong `docker/images.env`), chạy `migrate` trước, rồi `api` và `worker`. Mỗi vai trò chỉ nhận mật khẩu DB nó cần. Collector OpenTelemetry nằm ở profile `observability`.

## Biến môi trường

Danh sách đầy đủ, giá trị mặc định và mô tả nằm trong [`.env.example`](.env.example) (config của app) và [`.env.infra.example`](.env.infra.example) (hạ tầng compose). Cả hai file được **sinh từ schema zod** bằng `pnpm env:example`; không sửa tay, không chép lại ở đây. Thiếu hoặc sai biến thì process dừng lúc khởi động và liệt kê mọi biến lỗi.

## Cách thêm

Mọi ví dụ dưới đây lấy từ `src/` hoặc `test/fixtures/` (rút gọn bằng `// …`). Import từ `index.ts` của từng module core, ví dụ `src/core/queue/index.ts`. Module của dự án được bật trong `src/app.modules.ts` (`APP_MODULES.api` / `APP_MODULES.worker`).

### Config

Mỗi module khai báo schema zod của mình bằng `defineConfig(namespace, envMap, schema)`; mỗi giá trị có một biến env, mặc định chỉ nằm trong schema kèm `.describe()`. Trích `src/core/health/health.config.ts`:

```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const healthConfig = defineConfig(
  'health',
  {
    checkTimeoutMs: 'HEALTH_CHECK_TIMEOUT_MS',
    // …
  },
  z.object({
    checkTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(500)
      .describe('Timeout of each readiness check; …'),
    // …
  }),
);
```

Đọc config bằng injection `@Inject(healthConfig.KEY)` với kiểu `ConfigOf<typeof healthConfig>`. Luật liên quan nhiều namespace dùng `defineConfigRule(name, fn)`; luật chỉ áp ở production dùng `defineProductionRule(name, fn)`. Config của core được import trong `src/core/config/all-configs.ts`; `pnpm env:example` chỉ nạp file này, nên config của module dự án chưa tự xuất hiện trong `.env.example`. Cách đăng ký config của dự án vào `pnpm env:example`: Chưa quyết, xem sub-project 7.

### Queue và job

`defineQueue` khai báo queue, `defineJob` khai báo job có version và schema payload, `@JobHandler` gắn handler. Handler nhận `JobContext` (payload đã validate, `attempt`, `meta`, `signal`), không import BullMQ. Job có `meta.orgId` luôn chạy trong `OrgScope`. Enqueue (`JobQueue`, `SafeEnqueue`) hay ghi outbox trong một org thì job/event luôn thuộc org của context; `meta.orgId` khác org đó bị từ chối (spec §5.4), chỉ code hệ thống (ngoài org) mới chọn org qua `meta.orgId`. Trích `test/fixtures/fixture.jobs.ts`:

```ts
import {
  defineJob,
  defineQueue,
  JobHandler,
  type JobContext,
} from '../../src/core/queue/index.js';

export const FixtureQueue = defineQueue('fixture', { kind: 'io' });
export const RecordJob = defineJob({
  name: 'fixture.record',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
});
export const OrgJob = defineJob({
  name: 'fixture.org',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
  tenantSchedulable: true,
});

@Injectable()
@JobHandler(RecordJob)
export class RecordHandler {
  async handle(ctx: JobContext<{ key: string }>) {
    // …
  }
}
```

Handler phải là provider trong một module của `APP_MODULES.worker`; worker không khởi động nếu một job của queue nó consume thiếu handler. Enqueue qua `SafeEnqueue.enqueue(job, payload, opts?)` (`src/core/outbox/safe-enqueue.ts`): trong `UnitOfWork.run` job đi qua outbox và chỉ được gửi sau commit; ngoài transaction thì gửi thẳng Redis, lỗi thì ghi outbox với cùng `jobId`. Chỉ job có cờ `tenantSchedulable` (như `OrgJob` ở trên) mới được tenant đặt lịch. Lịch của tenant tạo bằng `ScheduledTaskService.upsert({ key, job, cron, timezone, payload, enabled })`; org lấy từ `RequestContext`, không nhận từ input.

### Cron tĩnh

`defineCron` với lịch đọc từ config (không hardcode biểu thức cron). Trích `src/core/outbox/outbox.jobs.ts`:

```ts
defineCron({
  key: 'core.outbox.cleanup',
  job: OutboxCleanupJob,
  payload: {},
  schedule: () => {
    const c = outboxConfig();
    return { cron: c.cleanupCron, tz: c.cleanupTz };
  },
});
```

Bỏ một cron: xoá `defineCron` rồi gọi `retireCron(key)`. Đây là cách duy nhất xoá cron tĩnh; worker không bao giờ xoá cron chỉ vì bản đang chạy không khai báo nó (rolling deploy).

### Event

`defineEvent` khai báo loại event có version và schema. Phát event bằng `EventPublisher.publish` bên trong `UnitOfWork.run`, để event ghi vào outbox cùng transaction với dữ liệu. Trích `test/fixtures/fixture.events.ts` và `test/fixtures/fixture.controller.ts`:

```ts
export const NoteCreated = defineEvent({
  type: 'fixture.note.created',
  version: 1,
  schema: z.object({ body: z.string() }),
});

await this.uow.run(async () => {
  await this.repo.insertSystemNote(body.body);
  await this.events.publish(NoteCreated, {
    data: { body: body.body },
    aggregate: { type: 'note', id: body.body, version: 1 },
    actor: { type: 'system', id: 'fixture' },
  });
});
```

Nhận event bằng `@EventSubscriber`; mỗi subscriber có tên `consumer` duy nhất và chạy trong `UnitOfWork` + inbox (xử lý đúng một lần phần ghi DB):

```ts
@Injectable()
@EventSubscriber({ consumer: 'fixture.audit', event: NoteCreated })
export class AuditSubscriber implements EventHandler<typeof NoteCreated> {
  async handle(e: EventEnvelope<{ body: string }>) {
    // …
  }
}
```

`handle()` chỉ làm việc với DB. Gọi HTTP, Redis hay gửi mail thì `SafeEnqueue` một job trong `handle()`; job đó chạy ngoài transaction và phải idempotent ([ADR 0006](docs/adr/0006-queue-outbox.md)).

### Bảng có RLS

Tạo migration bằng CLI của MikroORM (cần một Postgres đang chạy, kể cả với `--blank`), rồi viết SQL vào thân:

```bash
MIKRO_ORM_CLIENT_URL=postgresql://<superuser>:<password>@localhost:<cổng>/<db> \
  pnpm mikro-orm migration:create --blank --path src/migrations/app --name <tên>
```

Bảng có `org_id` bật RLS + FORCE, policy dùng `app_current_org()`, và cấp quyền theo từng bảng ngay trong migration. Trích `test/fixtures/migrations/Migration20260925023638_fixture_org_notes.ts`:

```ts
this.addSql(`ALTER TABLE fixture_org_notes ENABLE ROW LEVEL SECURITY;`);
this.addSql(`ALTER TABLE fixture_org_notes FORCE ROW LEVEL SECURITY;`);
this.addSql(`CREATE POLICY fixture_org_notes_isolation ON fixture_org_notes
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
this.addSql(
  `GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_org_notes TO app_user;`,
);
```

Truy vấn bảng tenant phải chạy trong `OrgScope.run(orgId, fn)`; thiếu org thì Postgres báo lỗi thay vì trả dữ liệu. Job có `meta.orgId` được `WorkerHost` bọc sẵn (`src/core/queue/worker-host.ts`):

```ts
() => (meta.orgId ? this.orgScope.run(meta.orgId, run) : run()),
```

`OrgScope.run` không được gọi bên trong một transaction đang mở với org khác. Bảng mới được `test/integration/core/database/rls-catalog.spec.ts` kiểm tra tự động ([ADR 0005](docs/adr/0005-multi-tenant-rls.md)).

### Route idempotent

`@Idempotent()` (`src/core/http/idempotency.decorator.ts`) bắt buộc header `Idempotency-Key` và principal đã xác thực trong `RequestContext`:

```ts
export const Idempotent = (opts: IdempotentOptions = {}) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_META, opts),
    UseInterceptors(IdempotencyInterceptor),
    // …
  );
```

Cùng key và cùng request thì trả lại response đã lưu; request trùng đang chạy nhận `409`; Redis lỗi nhận `503`. Status khi trả lại lấy từ `@HttpCode` của route, nên handler không được đổi status động. `ttlSec` chỉ dùng để rút ngắn thời gian giữ (ví dụ route tiền). SP1 chưa có auth; principal được gắn bởi sub-project 2 ([ADR 0007](docs/adr/0007-http-conventions.md)).

### Route PATCH (Merge Patch)

Body `application/merge-patch+json` (RFC 7396) validate bằng `mergePatchSchema`, áp vào resource bằng `mergePatchInto` (cả hai từ `core/http`):

```ts
const Editable = User.pick({ name: true, nickname: true, addr: true });
const PatchUser = mergePatchSchema(Editable);

@Patch(':id')
patch(@Body({ schema: PatchUser }) b: z.infer<typeof PatchUser>) {
  // …đọc `current`, assertIfMatch(ifMatch, current.version, { required: true })
  const next = mergePatchInto(Editable, current, b); // 422 nếu kết quả sai schema
}
```

Patch đệ quy: `{"addr":{"city":"Hue"}}` giữ nguyên `addr.zip`. `null` chỉ được gửi cho member nullable (`.nullable()`, `.nullish()`, `z.union([X, z.null()])`): member nullable bắt buộc thành `null`, member nullish bị xoá khỏi kết quả (handler phải ghi là xoá). Member optional nhưng không nullable từ chối `null`; field cần xoá được thì khai báo nullable. Key lạ bị từ chối ở mọi cấp. Mảng thay nguyên; record merge từng entry. Schema có `.default()`/`.prefault()`/`.catch()` ở bất kỳ đâu, union/intersection/pipe/lazy chứa object hoặc record key không phải string bị từ chối ngay lúc dựng. `applyMergePatch(target, patch)` là thuật toán RFC 7396 §2 thuần, không biết schema ([ADR 0007](docs/adr/0007-http-conventions.md)).

### Gọi HTTP ra ngoài

Chỉ dùng `HttpClient` (`src/core/resilience/http-client.ts`); không dùng `fetch` trực tiếp:

```ts
async request(provider: string, rawUrl: string, init: HttpRequestInit = {}): Promise<HttpResult>
```

`provider` phải là hằng số có tên (ví dụ `'sepay'`), không bao giờ là URL hay host do tenant nhập. Client chặn SSRF lúc kết nối, không theo redirect, giới hạn kích thước response, chỉ retry method idempotent, và không được gọi bên trong transaction DB. `ResilienceModule` (và `SecurityModule` cho `FieldCipher`) chưa được import trong module gốc: module nào dùng thì import nó ([ADR 0016](docs/adr/0016-outbound-http-ssrf.md)).

## Quy tắc

- **Cấm hard code:** timeout, TTL, giới hạn, batch, cron, retention, URL, origin, port chỉ nằm trong config schema zod của module sở hữu, mỗi giá trị có biến env. Secret không có giá trị mặc định. Định danh (tên queue, event, job, mã lỗi) là hằng số có tên trong registry của module.
- **Cài package:** `pnpm add <tên>` không ghi version, lấy bản latest đã publish ít nhất 1 ngày (`minimumReleaseAge: 1440` trong `pnpm-workspace.yaml`), `saveExact` bật sẵn. Trước khi cài chạy `pnpm view <tên> dist-tags peerDependencies`. Docker image và GitHub Action pin theo digest/SHA lấy bằng lệnh. Renovate chờ 3 ngày.
- **Ưu tiên có sẵn:** tính năng của framework/thư viện đang dùng → package được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm ADR liệt kê ứng viên đã loại.
- **Dùng CLI:** `nest g module|service|controller|…`, `mikro-orm migration:create`, `pnpm add`. Chỉ viết tay file không có generator. Không đoán flag: đọc `--help` hoặc tài liệu trước.
- **SQL chỉ qua `Db.execute`** (connection `app`, tự gắn transaction và session RLS hiện tại) **hoặc `RelayDb`** (connection `relay`, chỉ worker). Không bao giờ dùng `getConnection().execute`.
- **Không gọi I/O bên ngoài trong transaction DB:** ghi ý định bằng `SafeEnqueue`/`EventPublisher` trong transaction, gọi hệ thống ngoài trong job.
- **Ranh giới import** được `pnpm arch` (dependency-cruiser) kiểm tra: `@mikro-orm/*` chỉ trong `core/database`, `**/infra/**` và `src/migrations`; `bullmq` chỉ trong `core/queue`; Express, `tiny-merge-patch` chỉ trong `core/http`; `undici`, `ipaddr.js`, `cockatiel` chỉ trong `core/resilience`.
- **Lỗi:** không nuốt lỗi, không trả giá trị sai trong im lặng. Lỗi không lường trước được log đầy đủ ở server, client nhận problem+json `500 internal_error`. Không `any`, không `as never`; thu hẹp kiểu bằng type guard hoặc zod.

## Kiểm tra

```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm test:int
```

`pnpm test:int` và `pnpm test:chaos` cần Docker (Testcontainers). Kiểm tra đầy đủ trước khi merge:

```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm build && pnpm test:int && pnpm test:chaos && pnpm openapi:export && git diff --exit-code openapi.json
```

`openapi.json` được commit; sau khi đổi API chạy `pnpm build && pnpm openapi:export`.

## ADR

| ADR                                            | Nội dung                                         |
| ---------------------------------------------- | ------------------------------------------------ |
| [0001](docs/adr/0001-modular-monolith.md)      | Modular monolith                                 |
| [0002](docs/adr/0002-clone-and-upstream.md)    | Clone dự án và nhận cập nhật upstream            |
| [0003](docs/adr/0003-orm-mikro-orm.md)         | MikroORM, hai connection, migration có kiểm soát |
| [0004](docs/adr/0004-ports-and-adapters.md)    | Ports & adapters                                 |
| [0005](docs/adr/0005-multi-tenant-rls.md)      | Cô lập tenant bằng RLS fail-closed               |
| [0006](docs/adr/0006-queue-outbox.md)          | BullMQ, outbox giao dịch, inbox                  |
| [0007](docs/adr/0007-http-conventions.md)      | Quy ước HTTP, idempotency, rate limit            |
| [0009](docs/adr/0009-id-strategy.md)           | BIGINT nội bộ, UUIDv7 công khai                  |
| [0011](docs/adr/0011-cqrs-without-eventbus.md) | CQRS nhẹ, không dùng EventBus                    |
| [0012](docs/adr/0012-two-pagination-modes.md)  | Hai chế độ phân trang                            |
| [0013](docs/adr/0013-build-toolchain.md)       | Build toolchain, image và bảng số đo             |
| [0014](docs/adr/0014-observability.md)         | Observability, health, tắt êm                    |
| [0015](docs/adr/0015-cache-deferred.md)        | Cache: hoãn khỏi SP1                             |
| [0016](docs/adr/0016-outbound-http-ssrf.md)    | HTTP ra ngoài, chặn SSRF, mã hoá field           |

ADR 0008 (SePay) và 0010 (Better Auth) dành cho các sub-project sau. Mục "Nguồn" của ADR có nhắc tới báo cáo task và ruling (R1–R25); các tài liệu này nằm ở workspace điều phối, không nằm trong repo.
