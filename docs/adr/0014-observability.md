# 0014 — Observability: OpenTelemetry, trace xuyên outbox/job, metric, health và tắt êm

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Spec SP1 §1 (tiêu chí 9, 10) yêu cầu log của request và job có `traceId`/`requestId`, trace không đứt khi đi qua HTTP → outbox → job, có `/health/live`, `/health/ready` và tắt êm đúng thứ tự. Spec cha §12 và §16 chọn xuất qua OTLP (backend do dự án chọn), lấy mẫu trace 10% và chặn label có quá nhiều giá trị.

## Quyết định

### Export bằng OTLP/HTTP, SDK khởi động trước app

- `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`, export trace và metric bằng OTLP/HTTP tới `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces`, `/v1/metrics`). Collector (Task 19) chuyển tiếp tới backend.
- `src/instrumentation.ts` được nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js` (script `start:api`/`start:worker`). App là ESM nên, khi `OTEL_ENABLED=true`, file này đăng ký hook `import-in-the-middle/hook.mjs` bằng `module.register` kèm kênh `createAddHookMessageChannel()`, rồi `sdk.start()`, rồi `await waitForAllMessagesAcknowledged()` (mẫu trong README của import-in-the-middle; `doc/esm-support.md` của opentelemetry-js hướng tới `module.register`): loader chỉ bọc module mà instrumentation thật sự hook, không bọc mọi module của app. `import-in-the-middle` là dependency trực tiếp (cùng một bản với bản `@opentelemetry/instrumentation` dùng, để kênh message là cùng một instance). Không cần `--experimental-loader`. `CMD` của Dockerfile phải dùng đúng lệnh của script.
- Log không gửi qua OTLP: stdout (pino, đã redact) là đường log duy nhất. `logRecordProcessors: []` để NodeSDK không tự tạo exporter log theo env; instrumentation pino chỉ gắn `trace_id`/`span_id`.
- Tắt instrumentation `fs`, `dns`, `net` (trace gốc cho mỗi lần mở connection, không thêm giá trị). `ioredis`, `pg` bật `requireParentSpan`: lệnh nền (BullMQ poll, relay outbox) không tạo trace gốc, chỉ ghi span khi nằm trong request/job. Hệ quả: trong job, `BEGIN`/`set_config`/`COMMIT` của OrgScope chạy trước khi span job mở nên không được trace (độ trễ commit của job không thấy trong trace).

### Config OTel độc lập với `APP_ROLE`

`otelConfig` (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_METRICS_INTERVAL_MS`, `OTEL_EXPORTER_OTLP_TIMEOUT`) không đọc `appConfig`, vì `instrumentation.ts` chạy trước khi entrypoint đặt `APP_ROLE`. Tắt OTel (mặc định, và trong test) thì API OTel là no-op.

### Lấy mẫu

- Head sampling `OTEL_TRACES_SAMPLE_RATIO` (mặc định 10%): `ParentBasedSampler` với `root`, `remoteParentSampled`, `remoteParentNotSampled` đều là `TraceIdRatioBasedSampler`. `traceparent` do client gửi không ép được lấy mẫu 100%: parent từ xa bị lấy mẫu lại theo ratio.
- Job/event dùng `traceparent` trong meta làm parent từ xa. Ratio sampler quyết định theo trace id, nên job cùng trace nhận đúng quyết định của request gốc. Điều kiện: API và worker dùng cùng `OTEL_TRACES_SAMPLE_RATIO`.
- "Giữ 100% trace lỗi" làm bằng tail sampling ở collector, không làm trong app.

### Trace xuyên HTTP → outbox → relay → job → deliver: một cơ chế duy nhất

- Carrier là chuỗi W3C `traceparent` trong `JobMeta` (và header `traceparent` của dòng outbox, envelope event). `EventPublisher` ghi `currentTraceparent()`; relay chép header vào meta job dispatch; dispatch chép sang job deliver/deferred; `BullmqJobQueue` chỉ điền `currentTraceparent()` khi caller không truyền. `WorkerHost` chạy handler trong `withRemoteParent(meta.traceparent, 'job <name>')`, bên trong `RequestContext.run` và `OrgScope.run`, rồi đặt `traceId` vào context (log của handler mang trace id).
- `ContextModule` đặt `traceId`/`traceparent` từ span HTTP đang active; header `traceparent` của client chỉ vào context qua propagator của OTel, không copy thẳng.
- Đã loại `bullmq-otel`: nó tự propagate context qua `opts.telemetry.metadata` của job, không đi qua được outbox (dòng DB, relay poll không có context của request) và `addBulk` của relay sẽ gắn context của relay cho mọi job trong lô. Dùng cả hai là propagate hai lần với hai parent khác nhau. Giữ một cơ chế (meta) chạy được cho mọi đường: enqueue trực tiếp, outbox, deferred job.

### Metric

- `outbox_lag_seconds`: tuổi dòng outbox chưa publish cũ nhất, **bỏ qua dòng đã park** (chưa publish và `publish_attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS`, đúng điều kiện relay ngừng claim): tính vào thì một dòng hỏng ghim gauge tăng mãi và che độ trễ thật. Dòng park có gauge riêng `outbox_parked_events` (event sẽ không bao giờ được giao, cần người xử lý — nên có alert > 0). Cả hai lấy trong một câu query (`FILTER`) qua `RelayDb` (role `app_relay`).
- `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`: qua `JobQueue.stats()` (`getJobCounts('waiting')` + `getJobs(['waiting'], 0, 0, true)` của BullMQ). Tuổi tính từ lúc job đủ điều kiện chạy: `max(timestamp + opts.delay, processedOn)`, vì BullMQ đặt lại field `delay` = 0 khi promote job delayed (job của scheduler sẽ bị tính dư cả khoảng delay nếu chỉ dùng `timestamp`).
- `queue_failed_total{queue}`: counter, `WorkerHost` tăng trong `worker.on('failed')` (mỗi lần thử thất bại).
- Gauge là observable (callback), chỉ chạy khi reader thu thập mỗi `OTEL_METRICS_INTERVAL_MS`, nên tải Redis/DB bị chặn theo chu kỳ này. Chỉ worker đăng ký (`ObservabilityModule.forRoot({ worker: true })`). Callback lỗi: log `warn`, bỏ lần đo. Callback được gỡ ở `onModuleDestroy`, trước khi DB/Redis đóng.
- Không gắn attribute có quá nhiều giá trị (org id, job id, request id): chỉ tên queue.

### Tắt êm

`installShutdown(app)`: SIGTERM/SIGINT → `app.close()` → `shutdownTelemetry()` (flush **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi) → exit 0; lỗi → log, exit 1. Handler đăng ký bằng `process.on` và giữ tới khi thoát: signal lặp lại được log và bỏ qua (dùng `once` thì signal thứ hai chạy hành động mặc định và giết process giữa lúc drain khi process không phải PID 1). Hạn chót cứng `APP_SHUTDOWN_TIMEOUT_MS` (mặc định 28s) là timer **ref** (không `unref`: nếu không, `close()` treo trên promise không giữ handle nào làm process tự thoát 0 im lặng); quá hạn thì log lỗi và exit 1, trước SIGKILL của Kubernetes.

Ngân sách (config rule `shutdown-budget`): `APP_SHUTDOWN_TIMEOUT_MS >= OUTBOX_ENQUEUE_TIMEOUT_MS + QUEUE_SHUTDOWN_TIMEOUT_MS + QUEUE_SHUTDOWN_ABORT_GRACE_MS + APP_SHUTDOWN_RESERVE_MS` và `APP_SHUTDOWN_RESERVE_MS > OTEL_EXPORTER_OTLP_TIMEOUT`. Nest chạy `beforeApplicationShutdown` tuần tự theo module, nên `OutboxRelay.stop()` (chờ batch đang enqueue tối đa `OUTBOX_ENQUEUE_TIMEOUT_MS` khi Redis sập) cộng dồn với drain của WorkerHost. Mặc định 5s stop relay + 13s drain + 4s abort + 6s dự phòng (≈2–3s đóng DB/Redis + 3s timeout export OTLP cho lần flush cuối) = 28s < 30s grace mặc định. `preStop` sleep của Kubernetes bị trừ vào `terminationGracePeriodSeconds`, nên mặc định 28s giả định không có `preStop`; có thì tăng grace tương ứng.

### Package

`@opentelemetry/sdk-metrics` không cài riêng: dùng re-export `metrics` của `@opentelemetry/sdk-node`. `@opentelemetry/sdk-trace-base` vẫn cài riêng vì re-export `tracing` của sdk-node đã deprecated. `bullmq-otel` không có trong lockfile (chỉ còn là optional peer được khai báo của bullmq, không được resolve).

### Health, draining và thứ tự tắt (Task 18, R21)

- `@nestjs/terminus`. `/health/live` không kiểm tra dependency nào. `/health/ready` kiểm tra từng dependency với timeout `HEALTH_CHECK_TIMEOUT_MS` (mặc định 500 ms, phải nhỏ hơn `timeoutSeconds` của readiness probe). Cả hai route có `@SkipRateLimit()`.
- **R21: readiness của api chỉ kiểm DB; readiness của worker kiểm DB + Redis.** Lệch với spec cha §9 và brief (ready kiểm DB và Redis). Lý do: Redis dùng chung, api vẫn phục vụ khi Redis sập (rate limit chuyển sang insurance limiter, chỉ route `@Idempotent()` trả 503), nên gắn Redis vào readiness của api sẽ rút mọi pod api khỏi load balancer cùng lúc và biến sự cố một phần thành sự cố toàn phần. Worker không làm được gì khi thiếu Redis nên vẫn kiểm Redis.
- Ở api, lỗi readiness và draining trả `503 service_unavailable` dạng problem+json, không lộ kết quả từng indicator; server chỉ log một dòng `warn` (lỗi `expected`), logger của terminus tắt. Ở worker, 503 có body cố định `{status:"error"}` và một dòng `warn`.
- **api:** `ShutdownCoordinator` (chỉ đăng ký ở api) trong `beforeApplicationShutdown` bật draining (ready trả 503, live vẫn 200), rồi chờ `HEALTH_DRAIN_DELAY_MS` (mặc định 5 s) để load balancer ngừng gửi request. Trong lúc draining, mọi response mang `Connection: close` để kết nối keep-alive không giữ `server.close()` tới hạn chót. Sau đó HTTP server đóng, rồi queue, Redis, MikroORM, rồi flush telemetry.
- **worker:** server health tối thiểu (`node:http`, cổng `WORKER_HEALTH_PORT`) chỉ phục vụ `/health/*`. Worker không chờ drain delay (không có load balancer); nó drain job theo `QUEUE_SHUTDOWN_TIMEOUT_MS` rồi abort.
- Ngân sách: config rule `health-drain-budget` bắt `APP_SHUTDOWN_TIMEOUT_MS >= HEALTH_DRAIN_DELAY_MS + APP_SHUTDOWN_RESERVE_MS` (mặc định api 5 s + 6 s = 11 s), cộng với `shutdown-budget` của worker (18 + 4 + 6 = 28 s); cả hai ≤ 28 s < 30 s grace mặc định của Kubernetes.
- Đã loại `gracefulShutdownTimeoutMs` có sẵn của terminus: nó chỉ chờ khi `close()` nhận đúng chuỗi `'SIGTERM'` (`installShutdown` gọi `app.close()` không tham số), cờ của nó nằm trong `HealthCheckExecutor` nội bộ không được export, và không điều khiển/test được như cờ `Draining`. Đã loại `forceCloseConnections` của Nest vì nó huỷ cả request đang chạy.
- Tín hiệu thật: trên Linux (CI) test gửi SIGTERM thật; trên Windows test gửi IPC rồi `process.emit('SIGTERM')`, chạy đúng handler của `installShutdown`.

## Phương án đã loại

- `bullmq-otel` (R18): xem mục trace ở trên; propagate hai lần với hai parent khác nhau và không đi qua được outbox.
- Gửi log qua OTLP: không làm, stdout (pino) là đường log duy nhất.
- Giữ 100% trace lỗi trong app: làm bằng tail sampling ở collector.
- Terminus `gracefulShutdownTimeoutMs` và Nest `forceCloseConnections`: xem mục health.

## Hệ quả

- API và worker phải dùng cùng `OTEL_TRACES_SAMPLE_RATIO` để quyết định lấy mẫu của job khớp request gốc.
- Không thấy span `BullMQ` nội bộ và các câu `BEGIN`/`set_config`/`COMMIT` của `OrgScope` trong job.
- Nên đặt alert `outbox_parked_events > 0`.
- Spec SP1 §5.10 liệt kê metric pool DB; code SP1 chưa có metric pool DB riêng (chỉ có metric outbox và queue ở trên).
- Bật OTel làm api khởi động chậm hơn, sát ngưỡng 3 s tới ready; số đo ở [ADR 0013](0013-build-toolchain.md).
- `/health/ready` 200 chưa có schema trong OpenAPI (docs của terminus bị tắt để 503 không bị mô tả sai).

## Nguồn

Spec cha §9, §12, §16; spec SP1 §1 (tiêu chí 9–10), §5.10–5.11; review trước thực thi §3.1–3.2; R18, R21; báo cáo Task 16 (gồm vòng sửa 1), Task 18 (gồm vòng sửa 1), Task 19.
